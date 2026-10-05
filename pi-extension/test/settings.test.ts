import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelWarnings, parseModel, readModel, writeModel } from "../src/settings.ts";

test("parseModel splits at the first slash", () => {
  assert.deepEqual(parseModel("lunaroute/djev"), { provider: "lunaroute", id: "djev" });
  assert.deepEqual(parseModel("openrouter/inception/mercury-decide:free"), { provider: "openrouter", id: "inception/mercury-decide:free" });
  for (const bad of ["djev", "/djev", "lunaroute/", ""]) assert.equal(parseModel(bad), undefined, bad);
});

test("the saved model round-trips and bad files read as unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "s1a-"));
  const path = join(dir, "nested", "system-one-auto.json");
  assert.equal(readModel(path), undefined);
  writeModel(path, "lunaroute/clef-flash");
  assert.equal(readModel(path), "lunaroute/clef-flash");
  writeFileSync(path, "{not json");
  assert.equal(readModel(path), undefined);
  writeFileSync(path, JSON.stringify({ model: "no-slash" }));
  assert.equal(readModel(path), undefined);
});

test("warnings flag small context windows and other classifier APIs", () => {
  assert.deepEqual(modelWarnings({ api: "typesafe-system-one", contextWindow: 32768 }), []);
  assert.match(modelWarnings({ api: "typesafe-system-one", contextWindow: 8192 })[0], /too small/);
  assert.match(modelWarnings({ api: "llama-cpp-classify", contextWindow: 65536 })[0], /unverified/);
});
