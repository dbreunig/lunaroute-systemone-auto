"""Deterministic preprocessing: what code decides or computes before any Jev question.

The auto-mode prompt asks the classifier to expand chained commands, decode encoded payloads,
look through to files written earlier in the session, and ignore tool output. Jev does not reason
in steps, so this module does that work and hands Jev a small, structured state.
"""

import os
import re

MAX_TEXT = 2000
MAX_FILE = 4000
MAX_TRANSCRIPT = 40

# Read-only programs that never need a model call when they stay inside the project.
READ_ONLY = {
    "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "fd", "tree", "file", "stat", "du", "df",
    "which", "type", "echo", "printf", "true", "date", "whoami", "uname", "sort", "uniq", "cut", "diff",
}
READ_ONLY_GIT = {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame", "ls-files"}
SENSITIVE_PATH = re.compile(
    r"(\.env\b(?!\.example)|credentials|\.aws|\.ssh|id_rsa|id_ed25519|\.pem\b|\.key\b|secret|token|"
    r"\.netrc|\.npmrc|\.pypirc|\.kube|_history|\.pi/agent|keychain)",
    re.IGNORECASE,
)
# Decoding a payload and handing it to an interpreter cannot be verified (ENCODED COMMANDS).
ENCODED_EXEC = re.compile(
    r"(base64\s+(-d|--decode|-D)|xxd\s+-r|openssl\s+(base64|enc)\s+-d)[^|;&]*\|\s*(ba|z|da)?sh\b"
    r"|(eval|exec)\s+[\"']?\$\((echo|printf)[^)]*\|\s*(base64|xxd)"
    r"|\b(ba)?sh\s+-c\s+[\"']?\$\([^)]*base64\s+(-d|--decode)",
)


def split_segments(command: str) -> list[str]:
    """Split a shell command on ;, &&, ||, |, & and newlines, respecting quotes."""
    segments, buf, quote, i = [], [], None, 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"' and i + 1 < len(command):
                buf.append(command[i + 1])
                i += 1
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch in ";\n|&":
            if "".join(buf).strip():
                segments.append("".join(buf).strip())
            buf = []
            if command[i : i + 2] in ("&&", "||"):
                i += 1
        else:
            buf.append(ch)
        i += 1
    if "".join(buf).strip():
        segments.append("".join(buf).strip())
    return segments


def has_encoded_exec(command: str) -> bool:
    return bool(ENCODED_EXEC.search(command))


def _inside(path: str, cwd: str) -> bool:
    if not path:
        return False
    full = os.path.normpath(os.path.join(cwd, os.path.expanduser(path)))
    return full == cwd or full.startswith(cwd.rstrip("/") + "/")


def is_fast_path(action: dict, cwd: str) -> bool:
    """True when the action is plainly read-only inside the project and needs no judgment."""
    tool, args = action.get("tool"), action.get("input", {})
    if tool == "read":
        path = args.get("path", "")
        return _inside(path, cwd) and not SENSITIVE_PATH.search(path)
    if tool != "bash":
        return False
    command = args.get("command", "")
    if re.search(r"[<>`]|\$\(", command) or SENSITIVE_PATH.search(command):
        return False
    for segment in split_segments(command):
        words = segment.split()
        if not words:
            continue
        if words[0] == "git":
            if len(words) < 2 or words[1] not in READ_ONLY_GIT:
                return False
            if words[1] in ("branch", "remote") and len(words) > 2 and not words[2].startswith("-v"):
                return False
        elif words[0] == "find":
            if any(w in ("-delete", "-exec", "-execdir", "-ok") for w in words):
                return False
        elif words[0] not in READ_ONLY:
            return False
        # Absolute or home paths outside the project are not routine reads.
        for word in words[1:]:
            if word.startswith(("/", "~")) and not _inside(word, cwd) and word != "/dev/null":
                return False
    return True


def session_files(transcript: list[dict]) -> dict[str, str]:
    """Files the agent wrote or edited earlier in this session, with their latest known content."""
    files = {}
    for entry in transcript:
        if entry.get("role") != "tool":
            continue
        args = entry.get("input", {})
        if entry.get("tool") == "write":
            files[args.get("path", "")] = args.get("content", "")
        elif entry.get("tool") == "edit":
            prior = files.get(args.get("path", ""), "")
            files[args.get("path", "")] = (prior + "\n[edit] " + _edit_summary(args)).strip()
    return files


def _edit_summary(args: dict) -> str:
    edits = args.get("edits") or [{"oldText": args.get("oldText", ""), "newText": args.get("newText", "")}]
    return " | ".join(f"removes: {e.get('oldText', '')!r} adds: {e.get('newText', '')!r}" for e in edits)


def executed_session_files(action: dict, files: dict[str, str]) -> dict[str, str]:
    """Session-written files the action appears to run, source, or import (WRITTEN FILE EXECUTION)."""
    if action.get("tool") != "bash":
        return {}
    command = action.get("input", {}).get("command", "")
    return {
        path: _clip(content, MAX_FILE)
        for path, content in files.items()
        if path and (path in command or os.path.basename(path) in command.split())
    }


def _clip(text, limit=MAX_TEXT):
    text = text if isinstance(text, str) else str(text)
    return text if len(text) <= limit else text[:limit] + f"… [{len(text) - limit} more chars]"


def compact_action(action: dict, transcript: list[dict]) -> dict:
    tool, args = action.get("tool"), dict(action.get("input", {}))
    out = {"tool": tool}
    if tool == "bash":
        command = args.get("command", "")
        out["command"] = _clip(command, MAX_FILE)
        segments = split_segments(command)
        if len(segments) > 1:
            out["segments"] = segments
    elif tool == "write":
        out["path"] = args.get("path")
        out["content"] = _clip(args.get("content", ""), MAX_FILE)
        out["overwrites_session_file"] = args.get("path") in session_files(transcript)
    elif tool == "edit":
        out["path"] = args.get("path")
        out["change"] = _clip(_edit_summary(args), MAX_FILE)
    else:
        out["input"] = {k: _clip(v) for k, v in args.items()}
    if action.get("meta"):
        out["meta"] = action["meta"]  # harness ground truth, such as git status before a destructive command
    executed = executed_session_files(action, session_files(transcript))
    if executed:
        out["runs_files_written_this_session"] = executed
    return out


def compact_transcript(transcript: list[dict]) -> list[dict]:
    """Keep user turns, assistant prose, and tool calls with outcomes. Tool output never enters the state."""
    rows = []
    for entry in transcript[-MAX_TRANSCRIPT:]:
        role = entry.get("role")
        if role in ("user", "assistant"):
            rows.append({role: _clip(entry.get("text", ""))})
        elif role == "tool":
            row = {"tool_call": entry.get("tool"), "input": {k: _clip(v, 600) for k, v in entry.get("input", {}).items()}}
            if entry.get("outcome"):
                row["outcome"] = entry["outcome"]
            rows.append(row)
    return rows


def user_turns(transcript: list[dict], keep_first: int = 5, keep_last: int = 25) -> list[str]:
    """Every user turn can carry consent or a boundary; very long sessions keep the earliest and latest."""
    turns = [_clip(e.get("text", "")) for e in transcript if e.get("role") == "user"]
    if len(turns) > keep_first + keep_last:
        turns = turns[:keep_first] + [f"[{len(turns) - keep_first - keep_last} turns omitted]"] + turns[-keep_last:]
    return turns


def build_inputs(transcript: list[dict], action: dict, environment: dict) -> dict:
    return {
        "action": compact_action(action, transcript),
        "user_turns": user_turns(transcript),
        "transcript": compact_transcript(transcript),
        "environment": environment,
    }


def default_environment(cwd: str, user: str | None = None, remotes: list[str] | None = None) -> dict:
    """The prompt's Environment slots, at their conservative defaults."""
    return {
        "user": user or os.environ.get("USER", "unknown"),
        "trusted_repo": {"path": cwd, "remotes": remotes or []},
        "repository_visibility": "assume private unless shown public",
        "trusted_domains": [],
        "trusted_buckets": [],
        "internal_package_registry": None,
        "sensitive_remote_targets": "names containing prod or production as a whole word or segment",
        "protected_iac_scopes": "IAM, RBAC, networking, quota, node pools, and anything named prod or production",
        "host_containment": "ordinary developer machine with open internet",
        "agent_config_paths": ["~/.pi/agent/", ".pi/", "AGENTS.md"],
    }
