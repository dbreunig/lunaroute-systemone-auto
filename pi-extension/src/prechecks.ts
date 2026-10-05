/** Code checks that decide without a model: a port of jev_auto/state.py's prechecks. */

import { homedir } from "node:os";
import { posix } from "node:path";
import { PATTERNS, type Pattern, READ_ONLY, READ_ONLY_GIT } from "./program.generated.ts";
import { verdict, type Verdict } from "./verdict.ts";

export interface Action {
  tool: string;
  input: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const regex = (p: Pattern) => new RegExp(p.source, p.flags);
const ENCODED_EXEC = regex(PATTERNS.encoded_exec);
const SENSITIVE_PATH = regex(PATTERNS.sensitive_path);
const SHELL_SUBSTITUTION = regex(PATTERNS.shell_substitution);
const READ_ONLY_SET = new Set(READ_ONLY);
const READ_ONLY_GIT_SET = new Set(READ_ONLY_GIT);

const asString = (v: unknown) => (typeof v === "string" ? v : "");

export function bashCommand(action: Action): string {
  return action.tool === "bash" ? asString(action.input?.command) : "";
}

/** Split a shell command on ;, &&, ||, |, & and newlines, respecting quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: string | null = null;
  const flush = () => {
    if (buf.trim()) segments.push(buf.trim());
    buf = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        buf += command[i + 1];
        i++;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
    } else if (";\n|&".includes(ch)) {
      flush();
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") i++;
    } else buf += ch;
  }
  flush();
  return segments;
}

export function hasEncodedExec(command: string): boolean {
  return ENCODED_EXEC.test(command);
}

function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = process.env.HOME ?? homedir();
  const slash = path.indexOf("/");
  const user = slash === -1 ? path.slice(1) : path.slice(1, slash);
  const rest = slash === -1 ? "" : path.slice(slash);
  // Python resolves ~name from the password database; a sibling of HOME is the usual answer, and
  // treating any ~name as outside the project is the safe side either way.
  return (user ? posix.join(posix.dirname(home), user) : home) + rest;
}

function normalize(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

export function inside(path: string, cwd: string): boolean {
  if (!path) return false;
  const expanded = expandUser(path);
  const full = normalize(posix.isAbsolute(expanded) ? expanded : posix.join(cwd, expanded));
  return full === cwd || full.startsWith(`${cwd.replace(/\/+$/, "")}/`);
}

/** True when the action is plainly read-only inside the project and needs no judgment. */
export function isFastPath(action: Action, cwd: string): boolean {
  const args = action.input ?? {};
  if (action.tool === "read") {
    const path = asString(args.path);
    return inside(path, cwd) && !SENSITIVE_PATH.test(path);
  }
  if (action.tool !== "bash") return false;
  const command = asString(args.command);
  if (SHELL_SUBSTITUTION.test(command) || SENSITIVE_PATH.test(command)) return false;
  for (const segment of splitSegments(command)) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (words[0] === "git") {
      if (words.length < 2 || !READ_ONLY_GIT_SET.has(words[1])) return false;
      if ((words[1] === "branch" || words[1] === "remote") && words.length > 2 && !words[2].startsWith("-v")) return false;
    } else if (words[0] === "find") {
      if (words.some((w) => w === "-delete" || w === "-exec" || w === "-execdir" || w === "-ok")) return false;
    } else if (!READ_ONLY_SET.has(words[0])) return false;
    // Absolute or home paths outside the project are not routine reads.
    for (const word of words.slice(1)) {
      if ((word.startsWith("/") || word.startsWith("~")) && !inside(word, cwd) && word !== "/dev/null") return false;
    }
  }
  return true;
}

/** Stages 2 and 3: the checks that decide without building any context. Null means ask the model. */
export function precheck(action: Action, cwd: string): Verdict | null {
  if (hasEncodedExec(bashCommand(action))) {
    return verdict("block", "code", ["auto_mode_bypass"], "Encoded payload piped to an interpreter cannot be verified.");
  }
  if (isFastPath(action, cwd)) return verdict("allow", "fast_path", [], "Read-only action inside the project.");
  return null;
}
