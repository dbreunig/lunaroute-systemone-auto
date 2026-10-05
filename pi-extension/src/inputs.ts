/** The state the classifier sees: a port of jev_auto/state.py's builders and the sidecar's environment. */

import { execFileSync } from "node:child_process";
import { ENVIRONMENT_DEFAULTS, INPUT_FIELDS, INSTRUCTIONS, LIMITS, PATTERNS, QUESTIONS, type Question } from "./program.generated.ts";
import { type Action, bashCommand, splitSegments } from "./prechecks.ts";
import { clip, pyGet, pyRepr } from "./text.ts";

export interface Entry {
  role: "user" | "assistant" | "tool";
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  outcome?: string;
  id?: string;
}

export type Environment = Record<string, unknown> & { trusted_repo: { path: string; remotes: string[] } };

export interface Inputs {
  action: Record<string, unknown>;
  user_turns: string[];
  transcript: Record<string, unknown>[];
  environment: Environment;
}

export interface DspyRequest {
  state: { instructions: string; input_fields: string; inputs: Inputs };
  questions: Record<string, Question>;
}

export type Git = (cwd: string, ...args: string[]) => string;

const DESTROYS_WORK = new RegExp(PATTERNS.destroys_work.source, PATTERNS.destroys_work.flags);

/** Files the agent wrote or edited earlier in this session, with their latest known content. */
function sessionFiles(transcript: Entry[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of transcript) {
    if (entry.role !== "tool") continue;
    const args = entry.input ?? {};
    const path = pyGet(args, "path", "") as string;
    if (entry.tool === "write") files.set(path, pyGet(args, "content", "") as string);
    else if (entry.tool === "edit") files.set(path, `${files.get(path) ?? ""}\n[edit] ${editSummary(args)}`.trim());
  }
  return files;
}

function editSummary(args: Record<string, unknown>): string {
  const listed = pyGet(args, "edits", null) as Record<string, unknown>[] | null;
  const edits = listed?.length ? listed : [{ oldText: pyGet(args, "oldText", ""), newText: pyGet(args, "newText", "") }];
  return edits.map((e) => `removes: ${pyRepr(pyGet(e, "oldText", ""))} adds: ${pyRepr(pyGet(e, "newText", ""))}`).join(" | ");
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Session-written files the action appears to run, source, or import. */
function executedSessionFiles(action: Action, files: Map<string, string>): Record<string, string> {
  if (action.tool !== "bash") return {};
  const command = bashCommand(action);
  const words = command.split(/\s+/).filter(Boolean);
  const out: Record<string, string> = {};
  for (const [path, content] of files) {
    if (path && (command.includes(path) || words.includes(basename(path)))) out[path] = clip(content, LIMITS.maxFile);
  }
  return out;
}

function compactAction(action: Action, transcript: Entry[]): Record<string, unknown> {
  const args = action.input ?? {};
  const out: Record<string, unknown> = { tool: action.tool ?? null };
  if (action.tool === "bash") {
    const command = pyGet(args, "command", "") as string;
    out.command = clip(command, LIMITS.maxFile);
    const segments = splitSegments(command);
    if (segments.length > 1) out.segments = segments;
  } else if (action.tool === "write") {
    const path = pyGet(args, "path", null);
    out.path = path;
    out.content = clip(pyGet(args, "content", ""), LIMITS.maxFile);
    out.overwrites_session_file = typeof path === "string" && sessionFiles(transcript).has(path);
  } else if (action.tool === "edit") {
    out.path = pyGet(args, "path", null);
    out.change = clip(editSummary(args), LIMITS.maxFile);
  } else {
    out.input = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, clip(v, LIMITS.maxText)]));
  }
  if (action.meta && Object.keys(action.meta).length) out.meta = action.meta;
  const executed = executedSessionFiles(action, sessionFiles(transcript));
  if (Object.keys(executed).length) out.runs_files_written_this_session = executed;
  return out;
}

/** User turns, assistant prose, and tool calls with outcomes. Tool output never enters the state. */
function compactTranscript(transcript: Entry[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const entry of transcript.slice(-LIMITS.maxTranscript)) {
    if (entry.role === "user" || entry.role === "assistant") {
      rows.push({ [entry.role]: clip(pyGet(entry as Record<string, unknown>, "text", ""), LIMITS.maxText) });
    } else if (entry.role === "tool") {
      const input = Object.fromEntries(Object.entries(entry.input ?? {}).map(([k, v]) => [k, clip(v, LIMITS.maxToolInput)]));
      const row: Record<string, unknown> = { tool_call: entry.tool ?? null, input };
      if (entry.outcome) row.outcome = entry.outcome;
      rows.push(row);
    }
  }
  return rows;
}

/** Every user turn can carry consent or a boundary; very long sessions keep the earliest and latest. */
function userTurns(transcript: Entry[]): string[] {
  const first = LIMITS.userTurnsFirst;
  const last = LIMITS.userTurnsLast;
  let turns = transcript.filter((e) => e.role === "user").map((e) => clip(pyGet(e as Record<string, unknown>, "text", ""), LIMITS.maxText));
  if (turns.length > first + last) {
    turns = [...turns.slice(0, first), `[${turns.length - first - last} turns omitted]`, ...turns.slice(-last)];
  }
  return turns;
}

export function buildInputs(transcript: Entry[], action: Action, environment: Environment): Inputs {
  return {
    action: compactAction(action, transcript),
    user_turns: userTurns(transcript),
    transcript: compactTranscript(transcript),
    environment,
  };
}

/** The request exactly as DSPy builds it (questions typed "noul"). */
export function buildRequest(inputs: Inputs): DspyRequest {
  return { state: { instructions: INSTRUCTIONS, input_fields: INPUT_FIELDS, inputs }, questions: QUESTIONS };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

/** Reduce a Pi session branch to user turns, assistant prose, and tool calls with outcomes. */
export function branchToEntries(branch: unknown[], currentId: string, outcomes: Map<string, string>): Entry[] {
  const out: Entry[] = [];
  const byId = new Map<string, Entry>();
  for (const entry of branch as any[]) {
    if (entry?.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") out.push({ role: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text) out.push({ role: "assistant", text });
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type !== "toolCall") continue;
        if (block.id === currentId) return out; // the action under review is never part of its own context
        const call: Entry = { role: "tool", tool: block.name, input: block.arguments ?? {}, id: block.id };
        byId.set(block.id, call);
        out.push(call);
      }
    } else if (m.role === "toolResult") {
      const call = byId.get(m.toolCallId);
      if (call) call.outcome = outcomes.get(m.toolCallId) ?? (m.isError ? "error" : "ok");
    }
  }
  return out;
}

const runGit: Git = (cwd, ...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

const environments = new Map<string, Environment>();

/** The prompt's environment slots for this project, cached per working directory. */
export function environmentFor(cwd: string, extensionDir: string, git: Git = runGit): Environment {
  const cached = environments.get(cwd);
  if (cached) return cached;
  const remotes = [...new Set(git(cwd, "remote", "-v").split("\n").map((l) => l.split(/\s+/)).filter((p) => p.length > 1 && p[1]).map((p) => p[1]))].sort();
  const defaults = ENVIRONMENT_DEFAULTS as Record<string, unknown> & { agent_config_paths: string[] };
  const env = {
    ...defaults,
    user: process.env.USER || "unknown",
    trusted_repo: { path: cwd, remotes },
    agent_config_paths: [...defaults.agent_config_paths, extensionDir], // the monitor's own code
  } as Environment;
  environments.set(cwd, env);
  return env;
}

/** Run git status before commands that can destroy uncommitted work, so the classifier sees ground truth. */
export function withMeta(action: Action, cwd: string, git: Git = runGit): Action {
  if (!DESTROYS_WORK.test(bashCommand(action))) return action;
  const porcelain = git(cwd, "status", "--porcelain");
  const lines = porcelain.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
  return { ...action, meta: { gitStatus: { clean: !porcelain.trim(), changed_files: porcelain ? lines.length : 0 } } };
}
