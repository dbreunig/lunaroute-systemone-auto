# system-one-auto: a TypeScript Pi extension generated from the DSPy monitor

Date: 2026-10-05

## Goal

Replace the Python sidecar in the Pi extension with a pure TypeScript monitor that calls a System One classifier through Pi's own model registry. The default classifier is `lunaroute/djev`, authenticated by the user's existing Lunaroute login in Pi. Users can switch to any classifier model.

The DSPy program in `jev_auto/` stays the place where rules are written, benchmarked against Jev, and revised. A script exports it to TypeScript so each improvement can be carried over by re-running the export.

## Requirements

1. Translate the optimized DSPy program into TypeScript: questions, criteria, thresholds, ask floor, and rule table.
2. Run every code check that can decide a verdict before any model work, cheapest first. This is a reorder only. The set of checks and their verdicts do not change.
3. A script regenerates the TypeScript from the DSPy program.
4. The extension calls classifiers through Pi (`ctx.modelRegistry.classify`). The default is `lunaroute/djev`, and the user may choose any model of type `classifier`.
5. The extension never uses the name "jev". It is `system-one-auto`.

### Success criteria

- On all 118 dev and holdout cases, the TypeScript monitor builds the same request as Python and reaches the same verdict (decision, rules, reason) from the same answers.
- The extension runs in Pi with no Python, `uv`, or API key in the repo.
- Re-running the exporter after a rule revision updates the extension without hand edits, unless policy logic changed. In that case the parity test names the drifted case.
- djev's dev and holdout results are measured and reported. Jev's numbers are not assumed to carry over.

### Out of scope

- New code checks or changed verdicts.
- Re-tuning questions for djev or other classifiers.
- Renaming the Python package, repo, or Python benchmarks, which do call Jev.

## Current state

- `pi-extension/index.ts` starts `uv run python -m jev_auto.server` and sends every tool call to it over JSON lines. It builds the transcript before sending, even for calls the fast path then allows.
- `AutoModeMonitor.forward` runs the encoded-payload block and the read-only fast path, then sends one request with 127 Noul questions, then calls `compose`.
- ReAnchor kept 0 of 127 threshold fits, and no `tuned_monitor.json` exists. The program to export is the revised questions and criteria (revisions 1-3), default thresholds of 0.5, and `ASK_FLOOR = 0.2`.
- Lunaroute's catalog lists `djev` as `type: "classifier"`, `api: "typesafe-system-one"`, with a 32,768-token context window. Pi's System One adapter sends each question as given, changing only `type: "bool"` to `"noul"`, so DSPy's criteria objects reach the service unchanged.

## Design

### Module layout (`pi-extension/`)

| File | Responsibility | Source |
| --- | --- | --- |
| `index.ts` | Pi wiring: `tool_call` hook, flags, `/system-one-auto` command, Block / Allow once prompt, status line | current `index.ts` without `Sidecar` |
| `src/program.generated.ts` | Instructions, input fields, 127 questions with criteria, rule table, thresholds, ask floor, trimming limits, precheck regex sources | `scripts/export_ts.py` |
| `src/prechecks.ts` | Encoded-payload check, read-only fast path, segment splitting | port of `jev_auto/state.py` |
| `src/inputs.ts` | Pi branch to transcript entries, compact transcript, user turns, session-written files, environment (git remotes, cached per cwd), `git status` meta | port of `state.py` and `server.py` |
| `src/compose.ts` | Answers to allow / block / ask | port of `AutoModeMonitor.compose` |
| `src/monitor.ts` | Runs the stages in order; takes an injected `classify` function | replaces `forward` |
| `src/settings.ts` | Reads and writes `~/.pi/agent/system-one-auto.json` (chosen model) | new |
| `test/parity.test.ts`, `test/golden.json` | Python-vs-TypeScript parity on all cases | new |
| `test/transcript.test.ts` | Pi session branch to transcript entries | new |
| `bench/live.ts` | Live dev and holdout run against any classifier | new |

Deleted: `jev_auto/server.py`, the `Sidecar` class, and `pi-extension/test/harness.mjs` (replaced by the tests above).

### Stage order for one tool call

Each stage runs only if the previous ones did not decide.

1. Monitor disabled: allow.
2. Encoded payload (regex on the bash command): block, source `code`. This stays ahead of the fast path so an allow never pre-empts a block.
3. Read-only fast path (regexes over segments and paths): allow, source `fast_path`.
4. Resolve the configured classifier with `findOfType("classifier", provider, id)`. If it is missing: ask.
5. Build context: walk the session branch, look up the environment (cached per cwd), and run `git status` only for commands matching `DESTROYS_WORK`. Then build the inputs.
6. One classify request containing all questions.
7. `compose`.

### Classifier call

- `ctx.modelRegistry.classify(model, request, { signal })`, where `signal = AbortSignal.any([AbortSignal.timeout(SYSTEM_ONE_AUTO_TIMEOUT_MS), ctx.signal])`. The default timeout is 10,000 ms.
- Pi resolves authentication. The extension reads no keys.

### Choosing the classifier

- The default is `lunaroute/djev`.
- `--system-one-auto-model provider/id` sets it for one run and overrides the saved choice.
- `/system-one-auto model` opens a picker over `getAvailableOfType("classifier")`, listing each model's provider, API, and context window. `/system-one-auto model provider/id` sets it directly.
- Every choice is validated with `findOfType("classifier", …)`. Chat models and unknown IDs are rejected with a message, and the previous model stays.
- The picker choice is saved to `~/.pi/agent/system-one-auto.json`.
- The picker and the switch confirmation warn about two things:
  - Context windows below 32,768: "too small for this program (~24k-token requests)".
  - Non-System-One APIs: their handling of DSPy criteria objects is unverified, and calls may fall back to ask.
- The status line reads `system-one: <decision> · <provider>/<id>`.

### Failure handling (fail closed)

| Situation | Verdict |
| --- | --- |
| Configured classifier not in the catalog | ask, with a reason naming the model and suggesting install and sign-in |
| `stopReason` is `error`, or the call times out | ask, with the error message |
| Any expected answer missing or not a probability | ask; never decide from a partial answer |
| User cancels the turn (`ctx.signal` aborted) | block, reason "cancelled", no prompt |
| Verdict ask with no UI, or with `--system-one-auto-mode auto` | block, with the reason returned to the agent |
| HARD block | block, never prompts |

Request size: the trimming limits are exported constants, so both sides trim identically. No new truncation is added. An oversized request errors and becomes ask. `bench/live.ts` records real token usage so the headroom is measured, not estimated.

### Exporter (`scripts/export_ts.py`)

- Builds `AutoModeMonitor()` and loads `bench/results/tuned_monitor.json` when it exists.
- Produces questions with the same DSPy code path that builds the live request, so instructions, criteria, and per-field thresholds match what the service receives.
- Writes `pi-extension/src/program.generated.ts` with a "generated, do not edit" header that records the source git commit and a hash of the exported program.
- Exports the rule table (key, name, tier, must_name, adversarial), `ASK_FLOOR`, trimming limits, and precheck regex sources. It rejects Python-only regex syntax (`(?P<…>)`, `\Z`, mid-pattern inline flags) with an error.
- `--check` exits non-zero if the generated file is stale. A pytest test runs it.
- `--golden` writes `pi-extension/test/golden.json`. It runs the Python monitor over every dev and holdout case against the DSPy cache only and refuses live calls. Each record holds the inputs, the source (`code`, `fast_path`, or model), the request when one was sent, the cached answers, and the verdict.

### Tests

- `test/parity.test.ts` checks every golden case:
  - The TypeScript prechecks reach the same `code` or `fast_path` verdict.
  - Otherwise, the built request deep-equals Python's.
  - Composing the cached answers gives the same decision, rules, and reason.
- `test/transcript.test.ts` converts a recorded Pi session branch into transcript entries and checks that the current tool call is cut off and outcomes are attached.
- Both run with `npm test` in `pi-extension/`, offline. Existing `uv run pytest` stays green, plus the `--check` test.

### Live benchmark (`pi-extension/bench/live.ts`)

- Runs dev and holdout cases through `monitor.ts` against a live classifier (`--model provider/id`, default `lunaroute/djev`). It reports the same table as `bench/run.py` (exact, false allows, false blocks, asks, latency) plus token usage per request.
- Authenticates through Pi's SDK (`AuthStorage` / `ModelRegistry`), loading the user's providers including the Lunaroute package.
- First implementation step: confirm a standalone SDK script can resolve `lunaroute/djev`. If it cannot, run the benchmark from inside Pi via a hidden `/system-one-auto bench` command.

### Revision loop

1. Edit `jev_auto/rules.py` or `program.py`. Measure with `bench/run.py` (Jev) or `bench/live.ts` (any classifier).
2. Run `uv run python scripts/export_ts.py --golden`.
3. Run `npm test` in `pi-extension/`. A failure means policy logic changed beyond the exported data, and the failing case points at the TypeScript to update.

### Naming

- Package `pi-system-one-auto`, command `/system-one-auto`, flags `--system-one-auto-mode` (ask|auto) and `--system-one-auto-model`, env `SYSTEM_ONE_AUTO_TIMEOUT_MS`, settings file `~/.pi/agent/system-one-auto.json`.
- User- and agent-facing text says "System One auto-mode".
- The Python package, repo, and Python benchmarks keep their names.

### Documentation

- The README Pi section describes the TypeScript extension, model selection, the revision loop, and djev's measured results next to Jev's.
- `scripts/build_prompt_map.py` keeps pointing at the Python sources, which remain authoritative.
