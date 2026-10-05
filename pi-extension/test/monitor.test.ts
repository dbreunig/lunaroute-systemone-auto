import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CANCELLED, type Call, type Classify, decide } from "../src/monitor.ts";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const MODEL = "lunaroute/djev";

const reply = (answers: Record<string, number>) => ({
  stopReason: "stop",
  answers: Object.fromEntries(Object.entries(answers).map(([k, p]) => [k, { type: "bool", probability: p }])),
});

function call(c: any, classifier: Classify | null, extra: Partial<Call> = {}) {
  const seen = { context: 0, classify: 0 };
  const wrapped: Classify | null = classifier && (async (req, s) => (seen.classify++, classifier(req, s)));
  const built: Call = {
    action: c.action,
    cwd: c.environment.trusted_repo.path,
    model: MODEL,
    classifier: wrapped,
    timeoutMs: 1000,
    context: () => (seen.context++, { transcript: c.transcript, environment: c.environment, action: c.action }),
    ...extra,
  };
  return { built, seen };
}

test("decide matches Python end to end, and code verdicts build no context", async () => {
  for (const c of golden.cases) {
    const { built, seen } = call(c, async () => reply(c.answers ?? {}));
    assert.deepEqual(await decide(built), c.verdict, c.id);
    if (!c.inputs) assert.deepEqual(seen, { context: 0, classify: 0 }, `${c.id} should finish in code`);
  }
});

const modelCase = golden.cases.find((c: any) => c.inputs);

test("the request sent through Pi types questions as bool and keeps DSPy's criteria", async () => {
  let sent: any;
  await decide(call(modelCase, async (req) => ((sent = req), reply(modelCase.answers))).built);
  const first = Object.values(sent.questions)[0] as any;
  assert.equal(first.type, "bool");
  assert.deepEqual(first.criteria, golden.frame.questions[Object.keys(sent.questions)[0]].criteria);
  assert.deepEqual(sent.state.inputs, modelCase.inputs);
});

test("a missing classifier asks without building context", async () => {
  const { built, seen } = call(modelCase, null);
  const v = await decide(built);
  assert.equal(v.decision, "ask");
  assert.equal(v.source, "error");
  assert.match(v.reason, /lunaroute\/djev/);
  assert.equal(seen.context, 0);
});

test("classifier failures ask, never allow", async () => {
  const cases: [string, Classify, RegExp][] = [
    ["error", async () => ({ stopReason: "error", errorMessage: "rate limited" }), /rate limited/],
    ["throws", async () => { throw new Error("socket hang up"); }, /socket hang up/],
    ["partial", async () => ({ stopReason: "stop", answers: { user_boundary: { type: "bool", probability: 0.1 } } }), /incomplete/],
  ];
  for (const [name, classifier, reason] of cases) {
    const v = await decide(call(modelCase, classifier).built);
    assert.equal(v.decision, "ask", name);
    assert.match(v.reason, reason, name);
  }
});

const hang: Classify = (_req, signal) =>
  new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted" })));

test("a timeout asks", async () => {
  const v = await decide(call(modelCase, hang, { timeoutMs: 20 }).built);
  assert.equal(v.decision, "ask");
  assert.match(v.reason, /timed out after 20ms/);
});

test("a user cancel blocks quietly", async () => {
  const user = new AbortController();
  const pending = decide(call(modelCase, hang, { signal: user.signal, timeoutMs: 5000 }).built);
  user.abort();
  const v = await pending;
  assert.equal(v.decision, "block");
  assert.equal(v.reason, CANCELLED);
});

test("an invalid timeout asks instead of throwing", async () => {
  for (const timeoutMs of [Number.NaN, -5, Number.POSITIVE_INFINITY, 1e20]) {
    const v = await decide(call(modelCase, async () => reply(modelCase.answers), { timeoutMs }).built);
    assert.equal(v.decision, "ask", String(timeoutMs));
    assert.match(v.reason, /SYSTEM_ONE_AUTO_TIMEOUT_MS/);
  }
});
