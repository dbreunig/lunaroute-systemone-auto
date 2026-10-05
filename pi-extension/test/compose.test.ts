import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compose, decode } from "../src/compose.ts";
import { THRESHOLDS } from "../src/program.generated.ts";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));

test("composition matches Python on every model case", () => {
  for (const c of golden.cases.filter((c: any) => c.answers)) assert.deepEqual(compose(decode(c.answers)), c.verdict, c.id);
});

test("composition matches Python on synthetic answer sets", () => {
  assert.equal(golden.compose_cases.length, 400);
  golden.compose_cases.forEach((c: any, i: number) => assert.deepEqual(compose(decode(c.answers)), c.verdict, `synthetic ${i}`));
});

test("decode follows DSPy's threshold and confidence", () => {
  const all = Object.fromEntries(Object.keys(THRESHOLDS).map((k) => [k, 0.02]));
  const a = decode({ ...all, user_boundary: 0.5, repeat_rejected: 0.8 });
  assert.deepEqual(a.user_boundary, { value: true, probability: 0.5, confidence: 0 });
  assert.equal(a.repeat_rejected.value, true);
  assert.ok(Math.abs(a.repeat_rejected.confidence - 0.6) < 1e-12);
});

test("decode refuses partial or invalid answers", () => {
  const all = Object.fromEntries(Object.keys(THRESHOLDS).map((k) => [k, 0.02]));
  const { user_boundary: _, ...missing } = all;
  assert.throws(() => decode(missing), /user_boundary/);
  assert.throws(() => decode({ ...all, repeat_rejected: 1.5 }), /repeat_rejected/);
  assert.throws(() => decode({ ...all, repeat_rejected: "0.4" }), /repeat_rejected/);
});
