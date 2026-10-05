import assert from "node:assert/strict";
import { test } from "node:test";
import { makeClassifier } from "../src/transport.ts";

const DJEV = { provider: "lunaroute", id: "djev", api: "typesafe-system-one", baseUrl: "https://gw.example/v1" };
const request = {
  state: { instructions: "i", input_fields: "f", inputs: {} } as any,
  questions: { q: { type: "bool" as const, instructions: "Is it?", criteria: { true: { what: "yes" }, false: { what: "no" } } } },
};
const BROKEN = { stopReason: "error", errorMessage: "Cannot find module '@earendil-works/pi-ai/api/typesafe-system-one.lazy'" };

function registry(classify: () => Promise<any>, auth: any = { ok: true, headers: { Authorization: "Bearer tok" } }) {
  const calls = { classify: 0 };
  return {
    calls,
    classify: async () => (calls.classify++, classify()),
    getApiKeyAndHeaders: async () => auth,
  };
}

function fakeFetch(status: number, body: unknown) {
  const sent: any[] = [];
  const impl = async (url: URL | string, init: any) => {
    sent.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  };
  return { sent, impl: impl as typeof fetch };
}

test("uses Pi's classify when it works", async () => {
  const reg = registry(async () => ({ stopReason: "stop", answers: { q: { type: "bool", probability: 0.3 } } }));
  const f = fakeFetch(500, {});
  const reply = await makeClassifier(reg, DJEV, f.impl)(request, AbortSignal.timeout(1000));
  assert.equal(reply.answers?.q.probability, 0.3);
  assert.equal(f.sent.length, 0);
});

test("falls back to the System One endpoint when the provider's adapter cannot load", async () => {
  const reg = registry(async () => BROKEN);
  const f = fakeFetch(200, { answers: { q: { type: "noul", noul: 0.91 } }, model: "djev", usage: { input_tokens: 10 } });
  const classify = makeClassifier(reg, DJEV, f.impl);
  const reply = await classify(request, AbortSignal.timeout(1000));
  assert.deepEqual(reply, { stopReason: "stop", answers: { q: { type: "bool", probability: 0.91 } }, usage: { input: 10 } });
  assert.equal(f.sent[0].url, "https://gw.example/v1/systemone");
  assert.equal(f.sent[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(f.sent[0].body, { model: "djev", state: request.state, questions: { q: { ...request.questions.q, type: "noul" } } });
  await classify(request, AbortSignal.timeout(1000));
  assert.equal(reg.calls.classify, 1, "remembers the broken adapter");
});

test("does not fall back on ordinary service errors or other APIs", async () => {
  const f = fakeFetch(200, {});
  const rate = await makeClassifier(registry(async () => ({ stopReason: "error", errorMessage: "rate limited" })), DJEV, f.impl)(request, AbortSignal.timeout(1000));
  assert.equal(rate.errorMessage, "rate limited");
  const other = await makeClassifier(registry(async () => BROKEN), { ...DJEV, api: "llama-cpp-classify" }, f.impl)(request, AbortSignal.timeout(1000));
  assert.equal(other.stopReason, "error");
  assert.equal(f.sent.length, 0);
});

test("fallback failures come back as errors, never answers", async () => {
  const http = await makeClassifier(registry(async () => BROKEN), DJEV, fakeFetch(401, { error: { message: "Invalid or revoked API key" } }).impl)(request, AbortSignal.timeout(1000));
  assert.equal(http.stopReason, "error");
  assert.match(http.errorMessage as string, /401.*Invalid or revoked/);
  const noAuth = await makeClassifier(registry(async () => BROKEN, { ok: false, error: "not signed in" }), DJEV, fakeFetch(200, {}).impl)(request, AbortSignal.timeout(1000));
  assert.match(noAuth.errorMessage as string, /not signed in/);
  const bad = await makeClassifier(registry(async () => BROKEN), DJEV, fakeFetch(200, { answers: { q: { type: "score", score: 2 } } }).impl)(request, AbortSignal.timeout(1000));
  assert.equal(bad.stopReason, "stop");
  assert.equal(bad.answers?.q.probability, undefined); // decode() then refuses the partial answer and the monitor asks
});

const many = {
  state: request.state,
  questions: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`q${i}`, { ...request.questions.q }])),
};
const LIMIT = { stopReason: "error", errorMessage: `System One 400: "questions" exceeds this model's max_questions of 32` };

test("learns a model's question limit and sends parallel batches with the same state", async () => {
  const batches: string[][] = [];
  const reg = {
    classify: async (_m: unknown, req: any) => {
      const names = Object.keys(req.questions);
      if (names.length > 32) return LIMIT;
      batches.push(names);
      assert.equal(req.state, many.state);
      return { stopReason: "stop", answers: Object.fromEntries(names.map((n) => [n, { type: "bool", probability: 0.2 }])), usage: { input: 100 } };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const classify = makeClassifier(reg, DJEV, fakeFetch(500, {}).impl);
  const reply = await classify(many, AbortSignal.timeout(1000));
  assert.equal(reply.stopReason, "stop");
  assert.equal(Object.keys(reply.answers ?? {}).length, 70);
  assert.deepEqual(batches.map((b) => b.length), [32, 32, 6]);
  assert.equal(reply.usage?.input, 300);
  batches.length = 0;
  await classify(many, AbortSignal.timeout(1000));
  assert.deepEqual(batches.map((b) => b.length), [32, 32, 6], "remembers the limit");
});

test("one failed batch fails the whole call", async () => {
  let n = 0;
  const reg = {
    classify: async (_m: unknown, req: any) => {
      const names = Object.keys(req.questions);
      if (names.length > 32) return LIMIT;
      return ++n === 2 ? { stopReason: "error", errorMessage: "overloaded" } : { stopReason: "stop", answers: Object.fromEntries(names.map((q) => [q, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const reply = await makeClassifier(reg, DJEV, fakeFetch(500, {}).impl)(many, AbortSignal.timeout(1000));
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage as string, /overloaded/);
});

const INVALID = { stopReason: "error", errorMessage: "System One 400: the System One backend rejected the request as invalid" };
const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4.4);

test("packs questions under the token budget, keeping every question and the same state", async () => {
  const parts: any[] = [];
  const reg = {
    classify: async (_m: unknown, req: any) => {
      parts.push(req);
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const reply = await makeClassifier(reg, { ...DJEV, contextWindow: 400 }, fakeFetch(500, {}).impl)(many, AbortSignal.timeout(1000));
  assert.equal(reply.stopReason, "stop");
  assert.ok(parts.length > 3);
  assert.deepEqual(parts.flatMap((p) => Object.keys(p.questions)).sort(), Object.keys(many.questions).sort());
  for (const p of parts) {
    assert.equal(p.state, many.state);
    assert.ok(Math.ceil(JSON.stringify(p).length / 3.8) <= 400, "estimated within budget");
  }
});

test("learns a smaller token budget from invalid-request rejections and remembers it", async () => {
  let rejected = 0;
  const reg = {
    classify: async (_m: unknown, req: any) => {
      if (tokens(req) > 1000) return (rejected++, INVALID); // the backend's real limit, unknown to the client
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const classify = makeClassifier(reg, { ...DJEV, contextWindow: 32768 }, fakeFetch(500, {}).impl);
  const reply = await classify(many, AbortSignal.timeout(1000));
  assert.equal(reply.stopReason, "stop");
  assert.equal(Object.keys(reply.answers ?? {}).length, 70);
  assert.ok(rejected > 0);
  rejected = 0;
  await classify(many, AbortSignal.timeout(1000));
  assert.equal(rejected, 0, "remembers the budget");
});

test("a state too large for any question fails without guessing", async () => {
  let calls = 0;
  const reg = { classify: async () => (calls++, INVALID), getApiKeyAndHeaders: async () => ({ ok: true }) };
  const big = { ...many, state: { ...many.state, inputs: { transcript: "x".repeat(20000) } } };
  const reply = await makeClassifier(reg, { ...DJEV, contextWindow: 2000 }, fakeFetch(500, {}).impl)(big, AbortSignal.timeout(1000));
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage as string, /no question fits/);
  assert.equal(calls, 0);
});

test("concurrent calls each retry after another call has already learned the caps", async () => {
  const reg = {
    classify: async (_m: unknown, req: any) => {
      await new Promise((r) => setTimeout(r, 5));
      if (Object.keys(req.questions).length > 32) return LIMIT;
      if (tokens(req) > 1000) return INVALID;
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const classify = makeClassifier(reg, { ...DJEV, contextWindow: 32768 }, fakeFetch(500, {}).impl);
  const replies = await Promise.all([1, 2, 3, 4].map(() => classify(many, AbortSignal.timeout(2000))));
  assert.deepEqual(replies.map((r) => r.stopReason), ["stop", "stop", "stop", "stop"]);
});

test("an invalid-request rejection at a size that already worked does not shrink the budget", async () => {
  let failNext = false;
  const sizes: number[] = [];
  const reg = {
    classify: async (_m: unknown, req: any) => {
      if (tokens(req) > 1000) return INVALID;
      if (failNext) return ((failNext = false), INVALID); // a transient or content rejection, not a size one
      sizes.push(tokens(req));
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const classify = makeClassifier(reg, { ...DJEV, contextWindow: 32768 }, fakeFetch(500, {}).impl);
  await classify(many, AbortSignal.timeout(1000));
  const learned = Math.max(...sizes);
  failNext = true;
  const failed = await classify(many, AbortSignal.timeout(1000));
  assert.equal(failed.stopReason, "error", "the non-size rejection surfaces as an error");
  sizes.length = 0;
  const after = await classify(many, AbortSignal.timeout(1000));
  assert.equal(after.stopReason, "stop");
  assert.ok(Math.max(...sizes) >= learned * 0.9, "budget kept near the proven size");
});

test("estimates count UTF-8 bytes, so non-ASCII text is not underestimated", async () => {
  const parts: any[] = [];
  const reg = {
    classify: async (_m: unknown, req: any) => (parts.push(req), { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: "bool", probability: 0.2 }])) }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  const cjk = { ...many, state: { ...many.state, inputs: { note: "漢".repeat(600) } } };
  await makeClassifier(reg, { ...DJEV, contextWindow: 1200 }, fakeFetch(500, {}).impl)(cjk, AbortSignal.timeout(1000));
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(p)) / 3.8 <= 1200);
});

test("known models start with their caps: no learning round trips", async () => {
  const sizes: number[] = [];
  const reg = {
    classify: async (_m: unknown, req: any) => {
      const n = Object.keys(req.questions).length;
      if (n > 32) return LIMIT;
      sizes.push(n);
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "bool", probability: 0.2 }])) };
    },
    getApiKeyAndHeaders: async () => ({ ok: true }),
  };
  await makeClassifier(reg, { ...DJEV, contextWindow: 32768 }, fakeFetch(500, {}).impl, { max_questions: 32, token_budget: 4000 })(many, AbortSignal.timeout(1000));
  assert.ok(sizes.every((n) => n <= 32) && sizes.length >= 3, "first call already batched");
});
