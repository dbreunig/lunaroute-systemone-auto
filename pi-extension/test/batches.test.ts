import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildRequest } from "../src/inputs.ts";
import { toPiRequest } from "../src/monitor.ts";
import { KNOWN_CAPS } from "../src/program.generated.ts";
import { pack } from "../src/transport.ts";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));

// Answers can shift with what else is in a request, so DSPy tuning only transfers if both sides
// group the questions identically.
test("TypeScript cuts the same djev batches as the Python client on every model case", () => {
  const caps = KNOWN_CAPS["lunaroute/djev"];
  for (const c of golden.cases.filter((c: any) => c.inputs)) {
    const parts = pack(toPiRequest(buildRequest(c.inputs)), caps.max_questions, caps.token_budget);
    assert.ok(Array.isArray(parts), c.id);
    assert.deepEqual((parts as any[]).map((p) => Object.keys(p.questions)), c.djev_batches, c.id);
  }
});
