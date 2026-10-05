"""Time the monitor per stage on a sample of benchmark cases.

    uv run python -m bench.latency --fake        # local overhead only: an instant fake client stands in for Jev
    uv run python -m bench.latency               # live: real Jev calls, cache off
    uv run python -m bench.latency --sidecar     # also time the Pi sidecar's cold start and fast-path round trip

Cases run one at a time so timings do not contend. Each case reports the Jev call separately from
everything else (prechecks, state building, DSPy request building and decoding, composition).
"""

import argparse
import json
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

import dspy
from dspy.experimental import TypeSafe

from bench.cases import CASES
from jev_auto.program import AutoModeMonitor
from jev_auto.state import build_inputs, default_environment, has_encoded_exec, is_fast_path
from tests.test_program import FakeJev

ENV = default_environment("/work/repo", user="taylor", remotes=["git@github.com:acme/app.git"])
HOME = Path(__file__).resolve().parent.parent


class TimedClient:
    """Wraps a decision client and records how long each call takes."""

    supports_decision_requests = True

    def __init__(self, inner):
        self.inner = inner
        self.last = 0.0

    def __call__(self, state, questions):
        start = time.perf_counter()
        try:
            return self.inner(state=state, questions=questions)
        finally:
            self.last = time.perf_counter() - start


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, round(p / 100 * (len(values) - 1)))]


def summary(name, values_ms):
    if not values_ms:
        return f"  {name:<28} -"
    return (
        f"  {name:<28} p50 {statistics.median(values_ms):8.1f} ms   p95 {pct(values_ms, 95):8.1f} ms   "
        f"max {max(values_ms):8.1f} ms   (n={len(values_ms)})"
    )


def time_cases(cases, client, repeats):
    monitor = AutoModeMonitor()
    monitor.judge.set_lm(client)
    rows = []
    for c in cases:
        for _ in range(repeats):
            command = c["action"].get("input", {}).get("command", "")
            t0 = time.perf_counter()
            decided_in_code = has_encoded_exec(command) or is_fast_path(c["action"], "/work/repo")
            t1 = time.perf_counter()
            if not decided_in_code:
                build_inputs(c["transcript"], c["action"], ENV)
            t2 = time.perf_counter()
            client.last = 0.0
            prediction = monitor(transcript=c["transcript"], action=c["action"], environment=ENV)
            t3 = time.perf_counter()
            rows.append({
                "id": c["id"],
                "path": prediction.source,
                "precheck_ms": (t1 - t0) * 1e3,
                "state_ms": (t2 - t1) * 1e3,
                "total_ms": (t3 - t2) * 1e3,
                "jev_ms": client.last * 1e3,
                "local_ms": (t3 - t2 - client.last) * 1e3,
            })
    return rows


def time_sidecar(runs=3):
    """Cold start (spawn until ready) and one fast-path request, which never calls Jev."""
    request = json.dumps({"id": "1", "transcript": [], "action": {"tool": "read", "input": {"path": "README.md"}}, "cwd": str(HOME)})
    starts, trips = [], []
    for _ in range(runs):
        t0 = time.perf_counter()
        proc = subprocess.Popen(["uv", "run", "--project", str(HOME), "python", "-m", "jev_auto.server"], cwd=HOME,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        proc.stdout.readline()  # {"ready": true}
        t1 = time.perf_counter()
        proc.stdin.write(request + "\n")
        proc.stdin.flush()
        proc.stdout.readline()
        t2 = time.perf_counter()
        proc.terminate()
        proc.wait()
        starts.append((t1 - t0) * 1e3)
        trips.append((t2 - t1) * 1e3)
    return starts, trips


def main():
    load_dotenv(HOME / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--fake", action="store_true", help="instant fake client; measures local overhead only")
    parser.add_argument("--sample", type=int, default=20, help="number of cases to sample")
    parser.add_argument("--repeats", type=int, default=1, help="runs per case")
    parser.add_argument("--sidecar", action="store_true")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    random.seed(args.seed)
    cases = random.sample(CASES, min(args.sample, len(CASES)))
    inner = FakeJev() if args.fake else TypeSafe(cache=False, timeout=60)
    client = TimedClient(inner)
    dspy.configure(max_history_size=10_000)

    # Warm up imports, signature construction, and connection setup outside the measurement.
    time_cases(cases[:1], client, 1)
    rows = time_cases(cases, client, args.repeats)

    judged = [r for r in rows if r["path"] in ("jev", "error")]
    code = [r for r in rows if r["path"] in ("fast_path", "code")]
    print(f"\n{'FAKE client (local overhead only)' if args.fake else 'LIVE Jev, cache off'}: "
          f"{len(cases)} sampled cases x {args.repeats} repeat(s), {len(judged)} judged by Jev, {len(code)} decided in code\n")
    print("Decided in code (fast path, encoded payload):")
    print(summary("total", [r["total_ms"] for r in code]))
    print("\nJudged (one request, 127 questions):")
    print(summary("precheck", [r["precheck_ms"] for r in judged]))
    print(summary("state building", [r["state_ms"] for r in judged]))
    print(summary("jev call" + (" (fake)" if args.fake else ""), [r["jev_ms"] for r in judged]))
    print(summary("local (all but the call)", [r["local_ms"] for r in judged]))
    print(summary("total", [r["total_ms"] for r in judged]))
    errors = [r["id"] for r in rows if r["path"] == "error"]
    if errors:
        print(f"\n  {len(errors)} calls errored and were timed as errors: {errors[:5]}")

    if args.sidecar:
        starts, trips = time_sidecar()
        print("\nPi sidecar (uv run + import + ready; then one fast-path request over stdio):")
        print(summary("cold start", starts))
        print(summary("fast-path round trip", trips))

    out = HOME / "bench" / "results"
    out.mkdir(exist_ok=True)
    path = out / f"latency-{'fake' if args.fake else 'live'}-{int(time.time())}.json"
    path.write_text(json.dumps(rows, indent=2))
    print(f"\nwrote {path}")


if __name__ == "__main__":
    sys.exit(main())
