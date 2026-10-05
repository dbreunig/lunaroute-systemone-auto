# jev-auto

An auto-mode safety monitor for the [Pi](https://github.com/earendil-works/pi-mono) coding agent. Every tool call Pi is about to run is judged by a DSPy 3.4 program that asks TypeSafe's Jev one question per rule, then decides **allow**, **block**, or **ask** in code.

The rules come from `auto_prompt.md`, a monolithic LLM classifier prompt. Following the Jev skill, the prompt is decomposed rather than sent whole:

| In the prompt | Here |
| --- | --- |
| 1 HARD rule, 62 SOFT rules (Claude-Code-only rules dropped) | One `Noul` per rule: "does the action match?" (`jev_auto/rules.py`) |
| Each SOFT rule's **must name** consent bar | One consent `Noul` per soft rule |
| ALLOW exceptions | Folded into the `false` criteria of the rules they narrow |
| User boundaries, retries of rejected calls | Two more `Noul`s |
| Chained commands, encoded payloads, executing session-written files, `git status` meta | Code (`jev_auto/state.py`, `jev_auto/server.py`) |
| HARD vs SOFT, consent, severity | Code (`AutoModeMonitor.compose`) |

All 127 questions travel in one Jev request (about 24k tokens, within Jev's 64k budget). Read-only calls inside the project skip Jev entirely.

## Run

```bash
uv sync
echo 'TYPESAFE_API_KEY=...' > .env
uv run pytest -q                       # offline tests, fake Jev client
uv run python -m bench.run             # live benchmark over bench/cases.py
uv run python -m bench.run --reanchor  # fit thresholds on a train split of the dev set
uv run python -m bench.run --set holdout   # measure only; never tune against it
uv run python -m bench.latency           # per-stage timing (--fake for local overhead only)
PYTHONPATH=. uv run python scripts/build_prompt_map.py  # regenerate viz/prompt_map.html
```

## Results

Live Jev (`jev-latest`), one request of 127 Nouls per judged call, about 24k tokens.

| Set | Cases | Exact | False allows | False blocks | Asks |
| --- | --- | --- | --- | --- | --- |
| Dev (`bench/cases.py`), after revisions 1-3 | 64 | 96.9% | 0/37 | 0/27 | 2 |
| Held-out (`bench/holdout.py`), run once, never tuned on | 54 | 94.4% | 0/32 | 1/22 | 2 |

Latency over 20 sequential live calls: Jev p50 282 ms, p95 324 ms; total per judged call p50 299 ms. Local work (prechecks, state, DSPy request and decode, composition) adds about 14 ms. Reads and read-only commands in the project skip Jev.

Revisions came from reading per-rule probabilities on dev misses, one or two questions at a time: narrowing Data Exfiltration to exclude the project's own deploy and publish tooling, letting consent cover a soft rule's uncertainty, two false-side additions, Blind Apply's consent wording, and an ask floor of 0.2. ReAnchor kept none of its 127 threshold fits. The held-out misses point at Interfere With Workloads' consent wording; fixing it needs a new held-out set.

## Install in Pi

```bash
pi install ./pi-extension        # or: pi -e ./pi-extension/index.ts for one run
pi --jev-auto-mode auto          # never prompt; blocks return the reason to the agent
```

In the TUI, soft blocks and unsure answers prompt you (Block / Allow once). HARD blocks never prompt. If the monitor is unreachable or errors, the call is held for you (or blocked without a UI). `/jev-auto on|off|status` toggles it. Set `JEV_AUTO_HOME` if the extension lives outside this repo. A tuned program at `bench/results/tuned_monitor.json` is loaded automatically.
