"""Parity vectors for the TypeScript port, built from the DSPy cache without calling the service.

Every benchmark case is run through the Python monitor with a client that answers only from DSPy's
cache. The file records what Python sent and decided, so the TypeScript can be checked against it.
Synthetic answer sets cover composition branches the real cases rarely reach.
"""

import copy
import json
import random
from collections import Counter

from dotenv import load_dotenv

import dspy
from dspy.experimental import TypeSafe

from jev_auto.clients import KNOWN_CAPS, pack
from jev_auto.program import consent_field, match_field
from jev_auto.rules import RULES_BY_KEY

SOURCES = {"jev": "model", "code": "code", "fast_path": "fast_path"}
NEAR_BOUNDARY = (0.02, 0.1, 0.35, 0.42, 0.5, 0.58, 0.65, 0.9, 0.98)
CLEAR_MISS = (0.01, 0.03, 0.08)


class CacheOnly:
    """A decision client that answers only from the DSPy cache and records each request."""

    supports_decision_requests = True

    def __init__(self):
        self.inner = TypeSafe(cache=True)
        self.calls = []

    def __call__(self, state, questions):
        if dspy.cache.get(self.inner._request(state, questions)) is None:
            raise LookupError(
                "no cached answer for this request; run `uv run python -m bench.run --set dev` and `--set holdout` first"
            )
        answers = self.inner(state=state, questions=questions)
        self.calls.append({"state": copy.deepcopy(state), "questions": copy.deepcopy(questions), "answers": answers})
        return answers


def verdict_of(p):
    hard = p.decision == "block" and any(k in RULES_BY_KEY and RULES_BY_KEY[k].tier == "hard" for k in p.rules)
    return {"decision": p.decision, "source": SOURCES[p.source], "rules": list(p.rules), "reason": p.reason, "hard": hard}


def benchmark_cases(monitor, root):
    from bench.cases import CASES
    from bench.holdout import HOLDOUT
    from bench.run import ENV

    load_dotenv(root / ".env")  # TYPESAFE_BASE_URL or model overrides are part of the cache key
    client = CacheOnly()
    monitor.judge.set_lm(client)
    frame, cases = None, []
    for set_name, pool in (("dev", CASES), ("holdout", HOLDOUT)):
        for c in pool:
            before = len(client.calls)
            p = monitor(transcript=c["transcript"], action=c["action"], environment=ENV)
            call = client.calls[before] if len(client.calls) > before else None
            if call:
                this = {"instructions": call["state"]["instructions"], "input_fields": call["state"]["input_fields"], "questions": call["questions"]}
                frame = frame or this
                if this != frame:
                    raise SystemExit(f"{c['id']}: request frame differs from earlier cases")
            cases.append({
                "id": c["id"], "set": set_name, "group": c["group"], "label": c["label"], "expected_rules": list(c["rules"]),
                "transcript": c["transcript"], "action": c["action"], "environment": ENV,
                "inputs": call["state"]["inputs"] if call else None,
                "answers": {k: v["noul"] for k, v in call["answers"].items()} if call else None,
                "verdict": verdict_of(p),
                "djev_batches": pack(call["state"], call["questions"], **KNOWN_CAPS["lunaroute/djev"]) if call else None,
            })
    return frame, cases


def compose_cases(monitor, decisions, n=400, seed=7):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        hit_rate = rng.choice((0.0, 0.08, 0.2, 0.6))  # most real calls match few rules
        answers = {
            name: rng.choice(NEAR_BOUNDARY) if rng.random() < hit_rate else rng.choice(CLEAR_MISS)
            for name in decisions.types
        }
        if rng.random() < 0.25:  # the user consented to everything that matched: the cleared-by-consent branch
            answers["user_boundary"] = answers["repeat_rejected"] = rng.choice(CLEAR_MISS)
            for rule in monitor.rules:
                if rule.tier == "hard":
                    answers[match_field(rule)] = rng.choice(CLEAR_MISS)
                elif answers[match_field(rule)] >= 0.5:
                    answers[consent_field(rule)] = 0.9
        decoded = dspy.Prediction(**decisions._decode({k: {"noul": v} for k, v in answers.items()}))
        out.append({"answers": answers, "verdict": verdict_of(monitor.compose(decoded))})
    return out


def write_golden(monitor, program_hash, path):
    from scripts.export_ts import ROOT, decision_state

    frame, cases = benchmark_cases(monitor, ROOT)
    synthetic = compose_cases(monitor, decision_state(monitor))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"program_hash": program_hash, "frame": frame, "cases": cases, "compose_cases": synthetic}, indent=1, ensure_ascii=False))
    kinds = Counter(v["verdict"]["decision"] + ":" + v["verdict"]["reason"].split(":")[0].split(" — ")[0][:24] for v in synthetic)
    print(f"wrote {path.relative_to(ROOT)}: {len(cases)} cases ({sum(c['inputs'] is not None for c in cases)} model), {len(synthetic)} synthetic")
    for kind, count in sorted(kinds.items()):
        print(f"  {count:4d}  {kind}")
