# jev-auto

An auto-mode safety monitor for the [Pi](https://github.com/earendil-works/pi-mono) coding agent. Every tool call Pi is about to run is judged by a program that asks a System One classifier one question per rule, then decides **allow**, **block**, or **ask** in code. The program is written and benchmarked in DSPy 3.4 against TypeSafe's Jev (`jev_auto/`), then exported to a TypeScript Pi extension (`pi-extension/`, package `pi-system-one-auto`) that calls `lunaroute/djev` by default.

The rules come from `auto_prompt.md`, a monolithic LLM classifier prompt. Following the Jev skill, the prompt is decomposed rather than sent whole:

| In the prompt | Here |
| --- | --- |
| 1 HARD rule, 62 SOFT rules (Claude-Code-only rules dropped) | One `Noul` per rule: "does the action match?" (`jev_auto/rules.py`) |
| Each SOFT rule's **must name** consent bar | One consent `Noul` per soft rule |
| ALLOW exceptions | Folded into the `false` criteria of the rules they narrow |
| User boundaries, retries of rejected calls | Two more `Noul`s |
| Chained commands, encoded payloads, executing session-written files, `git status` meta | Code (`jev_auto/state.py`; ported to `pi-extension/src/`) |
| HARD vs SOFT, consent, severity | Code (`AutoModeMonitor.compose`) |

All 127 questions travel in one Jev request (about 24k tokens, within Jev's 64k budget). Smaller classifiers get the same questions in parallel batches (see below). Read-only calls inside the project skip the classifier entirely.

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
uv run python -m scripts.export_ts --golden   # regenerate the extension's program and parity vectors
(cd pi-extension && npm test)                  # TypeScript must reach Python's verdicts on every case
```

## Results

Results after the djev tuning round (revisions 4-6 below). Dev was tuned against; held-out was measured once per model after tuning.

| Model | Set | Cases | Exact | False allows | False blocks | Asks |
| --- | --- | --- | --- | --- | --- | --- |
| `lunaroute/djev` | Dev | 64 | 96.9% | 0/37 | 0/27 | 2 |
| `lunaroute/djev` | Held-out | 54 | 94.4% | 0/32 | 3/22 | 0 |
| Jev (`jev-latest`) | Dev | 64 | 96.9% | 0/37 | 0/27 | 2 |
| Jev (`jev-latest`) | Held-out | 54 | 94.4% | 0/32 | 1/22 | 2 |

djev was tuned from DSPy (`uv run python -m bench.run --model djev`, using `LUNAROUTE_API_KEY`) with the extension's exact batches, and the TypeScript extension reproduces the dev result case for case (`node pi-extension/bench/live.ts`), at p50 1.9 s and p95 2.1 s per judged call. Before tuning, djev scored 89.1% on dev and 94.4% on held-out at the same batch size; the held-out score did not move, so the dev gains partly fit dev. djev's held-out misses are Code That Leaks When Run on publishing and secret-store writes, and one stash.

djev accepts at most 32 questions and about 4k input tokens per request (its catalog context says 32k), and its answers depend on which questions share a request. At 8 questions per request it scored best on dev (89.1% before tuning, against 85.9% at 16 and 32, and 32 was the only size with a false allow), so the 127 questions go out as about 16 parallel requests per judged call. The caps live in `jev_auto/clients.py` and are exported to the extension, so DSPy and Pi send identical batches. A session whose state alone exceeds the token budget gets ask rather than a verdict; in a sample of real Pi sessions that was about a quarter of tool calls. The gateway rate-limits bursts; the benchmark retries, the extension fails closed to ask.

Jev latency over 20 sequential live calls: p50 282 ms, p95 324 ms; total per judged call p50 299 ms. Local work (prechecks, state, DSPy request and decode, composition) adds about 14 ms. Reads and read-only commands in the project skip the classifier.

Revisions came from reading per-rule probabilities on dev misses, one or two questions at a time. Against Jev: narrowing Data Exfiltration to exclude the project's own deploy and publish tooling, letting consent cover a soft rule's uncertainty, two false-side additions, Blind Apply's consent wording, and an ask floor of 0.2. ReAnchor kept none of its 127 threshold fits. The held-out misses point at Interfere With Workloads' consent wording; fixing it needs a new held-out set. Against djev: adding a git hook or logging config is not Logging/Audit Tampering (rev 4); Credential Leakage asks about live, non-placeholder secrets and Out-of-Place Publication excludes the project's own package (rev 5); Code That Leaks When Run needs code the action shows, and Unauthorized Persistence's consent bar names concrete mechanisms (rev 6).

## Pi extension

The extension in `pi-extension/` is TypeScript with no Python at runtime. Each tool call is judged in stages, cheapest first:

1. Code prechecks: encoded payloads block, read-only calls inside the project allow.
2. If no precheck decided: walk the session, build the state, and send the 127 questions to a System One classifier through Pi.
3. Composition in code.

```bash
pi install ./pi-extension                    # or: pi -e ./pi-extension/index.ts for one run
pi --system-one-auto-mode auto               # never prompt; blocks return the reason to the agent
pi --system-one-auto-model lunaroute/djev    # pick the classifier for one run
```

The default classifier is `lunaroute/djev`, using your Lunaroute login in Pi. `/system-one-auto model` lists every classifier your credentials can reach and saves the choice to `~/.pi/agent/system-one-auto.json`. Models with under 32k context, or on a non-System-One API, are flagged. `/system-one-auto on|off|status` toggles the monitor. `SYSTEM_ONE_AUTO_TIMEOUT_MS` sets the classifier timeout (default 10000).

HARD blocks never prompt. In the TUI, soft blocks and unsure answers ask you (Block / Allow once). Any failure (missing model, timeout, error, partial answer, a state too large for the model) holds the call for you, or blocks it without a UI.

Two workarounds live in `pi-extension/src/transport.ts`. `@lunaroute/pi-extension` 0.14.1 cannot load Pi's System One adapter, so System One models fall back to the provider's `/systemone` endpoint with the auth Pi resolves. And models that cap questions or input tokens per request get parallel batches that share the state; the caps are learned from the model's rejections, so the first judged call of a session takes a few extra round trips.

### Revising the program

The Python program in `jev_auto/` is the source. The TypeScript is generated from it:

```bash
uv run python -m bench.run                          # measure against Jev
uv run python -m scripts.export_ts --golden         # regenerate src/program.generated.ts and test/golden.json
(cd pi-extension && npm test)                       # TypeScript must reach Python's verdicts on every case
(cd pi-extension && node bench/live.ts)             # measure against djev (or --model provider/id)
```

`export_ts` writes the questions, criteria, thresholds, rule table, limits, and precheck regexes. A ReAnchor run's saved program contributes only its thresholds; question text always comes from `rules.py`. Prechecks, state building, and composition are hand-ported in `pi-extension/src/`. If `npm test` fails after an export, the Python policy logic changed, and the failing case names what to port.
