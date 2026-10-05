import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROGRAM_HASH } from "../src/program.generated.ts";
import { branchToEntries, buildInputs, buildRequest, environmentFor, withMeta } from "../src/inputs.ts";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const modelCases = golden.cases.filter((c: any) => c.inputs);

test("golden file matches the generated program", () => {
  assert.equal(golden.program_hash, PROGRAM_HASH, "re-run `uv run python -m scripts.export_ts --golden`");
});

test("inputs match what Python sent on every model case", () => {
  assert.ok(modelCases.length > 50);
  for (const c of modelCases) assert.deepEqual(buildInputs(c.transcript, c.action, c.environment), c.inputs, c.id);
});

test("request frame matches what Python sent", () => {
  const request = buildRequest(modelCases[0].inputs);
  assert.equal(request.state.instructions, golden.frame.instructions);
  assert.equal(request.state.input_fields, golden.frame.input_fields);
  assert.deepEqual(request.questions, golden.frame.questions);
  assert.deepEqual(Object.keys(request.state), ["instructions", "input_fields", "inputs"]);
});

// Review focus 2 and 3: non-string values use Python repr, missing fields become null.
test("compactAction keeps Python's shapes for odd inputs", () => {
  const env = golden.cases[0].environment;
  const write = buildInputs([], { tool: "write", input: { content: "x" } }, env).action;
  assert.deepEqual(write, { tool: "write", path: null, content: "x", overwrites_session_file: false });
  const other = buildInputs([], { tool: "grep", input: { pattern: "x", limit: 5, flags: ["-i"], opts: { a: true } } }, env).action;
  assert.deepEqual(other, { tool: "grep", input: { pattern: "x", limit: "5", flags: "['-i']", opts: "{'a': True}" } });
  const edit = buildInputs([], { tool: "edit", input: { path: "a.ts", edits: [{ oldText: "if (ok)", newText: "" }] } }, env).action;
  assert.deepEqual(edit, { tool: "edit", path: "a.ts", change: `removes: 'if (ok)' adds: ''` });
});

const branch = [
  { type: "message", message: { role: "user", content: "deploy it" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Pushing." }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "git push" } }] } },
  { type: "message", message: { role: "toolResult", toolCallId: "t1", isError: false, content: [{ type: "text", text: "secret output" }] } },
  { type: "custom", data: {} },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "fly deploy" } }] } },
];

test("branchToEntries cuts at the call under review and drops tool output", () => {
  const entries = branchToEntries(branch, "t2", new Map([["t1", "rejected-by-user"]]));
  assert.deepEqual(entries, [
    { role: "user", text: "deploy it" },
    { role: "assistant", text: "Pushing." },
    { role: "tool", tool: "bash", input: { command: "git push" }, id: "t1", outcome: "rejected-by-user" },
  ]);
  assert.ok(!JSON.stringify(entries).includes("secret output"));
});

// Review focus 5: a call issued by another tool has an id that never appears in the branch.
test("branchToEntries returns the whole branch when the call is nested", () => {
  const entries = branchToEntries(branch, "t2/1", new Map());
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[3], { role: "tool", tool: "bash", input: { command: "fly deploy" }, id: "t2" });
});

test("environmentFor reads remotes, appends the extension dir, and survives a non-repo", () => {
  const git = (_cwd: string, ...args: string[]) =>
    args[0] === "remote" ? "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n" : "";
  const env = environmentFor("/tmp/envtest-a", "/ext", git);
  assert.deepEqual(env.trusted_repo, { path: "/tmp/envtest-a", remotes: ["git@github.com:a/b.git"] });
  assert.equal((env.agent_config_paths as string[]).at(-1), "/ext");
  assert.equal(Object.keys(env)[0], "user");
  assert.deepEqual(environmentFor("/tmp/envtest-b", "/ext", () => "").trusted_repo, { path: "/tmp/envtest-b", remotes: [] });
});

test("withMeta attaches git status only before commands that destroy work", () => {
  const git = () => " M a.ts\n?? b.ts\n";
  const reset = withMeta({ tool: "bash", input: { command: "git reset --hard" } }, "/r", git);
  assert.deepEqual(reset.meta, { gitStatus: { clean: false, changed_files: 2 } });
  const clean = withMeta({ tool: "bash", input: { command: "rm -rf build" } }, "/r", () => "");
  assert.deepEqual(clean.meta, { gitStatus: { clean: true, changed_files: 0 } });
  assert.equal(withMeta({ tool: "bash", input: { command: "npm test" } }, "/r", git).meta, undefined);
});
