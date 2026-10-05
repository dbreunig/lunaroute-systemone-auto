/** Code checks that decide without a model: a port of jev_auto/state.py's prechecks. */

import { homedir } from "node:os";
import nodePath from "node:path";
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

type PathApi = typeof nodePath;

function expandUser(path: string, p: PathApi): string {
  const m = /^~([^/\\]*)(.*)$/.exec(path);
  if (!m) return path;
  const home = process.env.HOME ?? homedir();
  // Python resolves ~name from the password database; a sibling of HOME is the usual answer, and
  // treating any ~name as outside the project is the safe side either way.
  return (m[1] ? p.join(p.dirname(home), m[1]) : home) + m[2];
}

/** Whether path resolves inside cwd, by the platform's path rules (Python's os.path does the same). */
export function inside(path: string, cwd: string, p: PathApi = nodePath): boolean {
  if (!path) return false;
  const root = p.resolve(cwd);
  const rel = p.relative(root, p.resolve(root, expandUser(path, p)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** True when the action is plainly read-only inside the project and needs no judgment. */
export function isFastPath(action: Action, cwd: string, p: PathApi = nodePath): boolean {
  const args = action.input ?? {};
  if (action.tool === "read") {
    const path = asString(args.path);
    // Pi trims, strips a leading @, and converts file:// URLs before reading; those paths can point anywhere.
    if (path !== path.trim() || path.startsWith("@") || path.startsWith("file:")) return false;
    return inside(path, cwd, p) && !SENSITIVE_PATH.test(path);
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
      const absolute = word.startsWith("/") || word.startsWith("~") || p.isAbsolute(word);
      if (absolute && !inside(word, cwd, p) && word !== "/dev/null") return false;
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
