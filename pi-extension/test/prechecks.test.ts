import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasEncodedExec, isFastPath, precheck, splitSegments } from "../src/prechecks.ts";
import { clip, pyRepr } from "../src/text.ts";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const CWD = "/work/repo";
const bash = (command: string) => ({ tool: "bash", input: { command } });

test("prechecks agree with Python on every golden case", () => {
  for (const c of golden.cases) {
    const v = precheck(c.action, c.environment.trusted_repo.path);
    if (c.verdict.source === "code" || c.verdict.source === "fast_path") assert.deepEqual(v, c.verdict, c.id);
    else assert.equal(v, null, c.id);
  }
});

test("splitSegments splits on operators outside quotes", () => {
  assert.deepEqual(splitSegments(`ls && echo "a;b" | wc -l; git status`), ["ls", `echo "a;b"`, "wc -l", "git status"]);
  assert.deepEqual(splitSegments(`echo 'x && y' || true`), [`echo 'x && y'`, "true"]);
  assert.deepEqual(splitSegments(`echo "say \\"hi\\" & go"`), [`echo "say \\"hi\\" & go"`]);
});

test("encoded payloads piped to a shell are detected", () => {
  assert.ok(hasEncodedExec("echo aGkK | base64 -d | sh"));
  assert.ok(!hasEncodedExec("base64 -d file.txt > out.bin"));
});

// Review focus 4: paths that leave the project never take the fast path.
test("fast path stays inside the project", () => {
  assert.ok(isFastPath(bash("ls src/ && git status"), CWD));
  assert.ok(isFastPath({ tool: "read", input: { path: "/work/repo/./src/../README.md" } }, CWD));
  assert.ok(!isFastPath(bash("cat /etc/passwd"), CWD));
  assert.ok(!isFastPath(bash("cat /work/repo/../other/notes.txt"), CWD));
  assert.ok(!isFastPath(bash("cat ~/notes.txt"), CWD));
  assert.ok(!isFastPath(bash("cat ~bob/notes.txt"), CWD));
  assert.ok(!isFastPath({ tool: "read", input: { path: "/work/repo-other/x" } }, CWD));
  assert.ok(!isFastPath({ tool: "read", input: { path: null } }, CWD));
  assert.ok(!isFastPath(bash("cat .env"), CWD));
  assert.ok(!isFastPath(bash("ls > out.txt"), CWD));
  assert.ok(!isFastPath(bash("git push"), CWD));
});

// Review focus 1: Python clips by code points, not UTF-16 units.
test("clip counts code points like Python", () => {
  const out = clip("😀".repeat(2001), 2000);
  assert.ok(out.endsWith("… [1 more chars]"));
  assert.equal(Array.from(out.slice(0, out.indexOf("…"))).length, 2000);
  assert.equal(clip("短".repeat(5), 5), "短".repeat(5));
});

// Review focus 2: non-string values render as Python's repr.
test("pyRepr matches Python repr", () => {
  const value = ["a", "it's", 'say "hi"', "both ' \"", 1, 2.5, true, null, { k: "v" }, "tab\tnl\n", "\u0007", "é", "\u200b", "\\"];
  assert.equal(
    pyRepr(value),
    String.raw`['a', "it's", 'say "hi"', 'both \' "', 1, 2.5, True, None, {'k': 'v'}, 'tab\tnl\n', '\x07', 'é', '\u200b', '\\']`,
  );
  assert.equal(clip(5, 2000), "5");
});

// Pi strips a leading @, trims, and converts file:// URLs before reading.
test("read paths that Pi rewrites go to the model", () => {
  for (const path of ["@/etc/hosts", "file:///etc/hosts", "@~/Documents/x.txt", " /etc/hosts", "@src/app.ts"]) {
    assert.ok(!isFastPath({ tool: "read", input: { path } }, CWD), path);
  }
});
