"""JSON-lines sidecar for the Pi extension: one request per line on stdin, one verdict per line on stdout.

Request:  {"id": "...", "transcript": [...], "action": {"tool": "bash", "input": {...}}, "cwd": "/path"}
Response: {"id": "...", "decision": "allow|block|ask", "rules": [...], "reason": "...", "source": "...", "hard": bool}
"""

import json
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

import dspy
from dspy.experimental import TypeSafe

from jev_auto.program import AutoModeMonitor
from jev_auto.rules import RULES_BY_KEY
from jev_auto.state import default_environment

HOME = Path(__file__).resolve().parent.parent
TUNED = HOME / "bench" / "results" / "tuned_monitor.json"
DESTROYS_WORK = re.compile(r"git\s+(reset\s+--hard|checkout\s+(--\s+)?\.|clean\s+-\w*f|restore\s+\.|stash\s+(drop|clear))|\brm\s+-\w*r")


def git(cwd, *args):
    try:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


@lru_cache(maxsize=32)
def environment(cwd):
    remotes = sorted({line.split()[1] for line in git(cwd, "remote", "-v").splitlines() if len(line.split()) > 1})
    env = default_environment(cwd, remotes=remotes)
    env["agent_config_paths"].append(str(HOME))  # the monitor's own code and config
    return env


def with_meta(action, cwd):
    """Mirror the harness: run git status itself before commands that can destroy uncommitted work."""
    command = action.get("input", {}).get("command", "") if action.get("tool") == "bash" else ""
    if not DESTROYS_WORK.search(command):
        return action
    porcelain = git(cwd, "status", "--porcelain")
    status = {"clean": not porcelain.strip(), "changed_files": len(porcelain.splitlines())}
    return {**action, "meta": {"gitStatus": status}}


def main():
    load_dotenv(HOME / ".env")
    dspy.configure(lm=TypeSafe(timeout=30))
    monitor = AutoModeMonitor()
    if TUNED.exists():
        monitor.load(str(TUNED))
    print(json.dumps({"ready": True, "tuned": TUNED.exists()}), flush=True)

    for line in sys.stdin:
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            cwd = request["cwd"]
            p = monitor(transcript=request["transcript"], action=with_meta(request["action"], cwd), environment=environment(cwd))
            hard = any(RULES_BY_KEY.get(k) and RULES_BY_KEY[k].tier == "hard" for k in p.rules) and p.decision == "block"
            response = {"decision": p.decision, "rules": p.rules, "reason": p.reason, "source": p.source, "hard": hard}
        except Exception as e:  # noqa: BLE001 - every failure becomes an explicit, fail-closed answer
            response = {"decision": "ask", "rules": [], "reason": f"Monitor error: {type(e).__name__}: {e}", "source": "error", "hard": False}
        print(json.dumps({"id": request.get("id"), **response}), flush=True)


if __name__ == "__main__":
    main()
