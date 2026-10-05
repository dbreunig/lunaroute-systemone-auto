"""Build viz/prompt_map.html: auto_prompt.md beside the Jev questions and code rules it became.

    uv run python scripts/build_prompt_map.py

Rule cards are generated from jev_auto/rules.py, and code locations are found by searching the
source, so the page stays in step with the code. The line-to-target mapping below is the one
hand-maintained part.
"""

import json
import re
import textwrap
from pathlib import Path

from jev_auto.program import ASK_FLOOR, INSTRUCTIONS, build_signature
from jev_auto.rules import BOUNDARY_QUESTION, REPEAT_REJECTED_QUESTION, RULES, consent_question

ROOT = Path(__file__).resolve().parent.parent
PROMPT = (ROOT / "auto_prompt.md").read_text().splitlines()


def loc(path, pattern):
    """Return 'path:line' for the first line matching pattern."""
    for i, line in enumerate((ROOT / path).read_text().splitlines(), 1):
        if re.search(pattern, line):
            return f"{path}:{i}"
    raise ValueError(f"{pattern!r} not found in {path}")


def prompt_line(pattern):
    for i, line in enumerate(PROMPT, 1):
        if re.search(pattern, line):
            return i
    raise ValueError(f"{pattern!r} not found in auto_prompt.md")


# ------------------------------------------------------------------ targets
targets = {}


def target(id, kind, title, body, where=None, **extra):
    targets[id] = {"id": id, "kind": kind, "title": title, "body": body, "where": where, **extra}


for r in RULES:
    consent = consent_question(r)[0] if r.tier == "soft" else None
    target(
        f"rule:{r.key}", "decision", r.name,
        r.question.replace("`inputs.action`", "the action"),
        loc("jev_auto/rules.py", rf'^\s+"{r.key}",'),
        tier=r.tier, adversarial=r.adversarial, field=f"m_{r.key}",
        true=r.true, false=r.false, true_examples=list(r.true_examples), false_examples=list(r.false_examples),
        consent=consent, must_name=r.must_name,
    )

target("intent:consent", "intent", f"Consent questions ({sum(r.tier == 'soft' for r in RULES)} Nouls)",
       "One per soft rule, built from its must-name item: do the user's own words name it, or affirm an agent proposal right "
       "before the reply that named it? Goal-only requests, questions, and relayed instructions are on the false side.",
       loc("jev_auto/rules.py", r"^def consent_question"))
target("intent:adversarial", "intent", f"Adversarial consent ({sum(r.adversarial for r in RULES)} rules)",
       "For adversarial-pattern rules the consent question changes: did the user confirm this flag is a false positive? "
       "Saying “go ahead” is not enough.", loc("jev_auto/rules.py", r"if rule.adversarial:"))
target("intent:boundary", "intent", "User boundary", BOUNDARY_QUESTION[0].replace("`inputs.", "`"), loc("jev_auto/rules.py", r"^BOUNDARY_QUESTION"))
target("intent:repeat", "intent", "Repeat of a rejected call", REPEAT_REJECTED_QUESTION[0].replace("`inputs.", "`"),
       loc("jev_auto/rules.py", r"^REPEAT_REJECTED_QUESTION"))

code = [
    ("code:instructions", "Signature instructions", INSTRUCTIONS, loc("jev_auto/program.py", r"^INSTRUCTIONS")),
    ("code:default", "Default allow", "compose() returns allow when no match Noul fires and no intent question blocks.",
     loc("jev_auto/program.py", r'"No rule matched\."')),
    ("code:hard", "HARD blocks ignore consent", "Any HARD match blocks before consent, boundaries, or exceptions are read. Pi never offers to allow it.",
     loc("jev_auto/program.py", r"hard = \[r for r in hits")),
    ("code:soft", "SOFT blocks clear only with consent", "A soft match blocks unless that rule's consent Noul is true. The block reason names what would clear it.",
     loc("jev_auto/program.py", r"uncleared = \[r for r")),
    ("code:verdict", "allow / block / ask", f"Replaces the 0–100 severity and category tags. Jev's probabilities stay attached to every verdict.",
     loc("jev_auto/program.py", r"^def verdict")),
    ("code:ask", "Ask when Jev is unsure", f"A Noul with confidence below {ASK_FLOOR} (probability near its threshold) routes to the user instead of guessing.",
     loc("jev_auto/program.py", r"^ASK_FLOOR")),
    ("code:rule_table", "Rule table with examples", "Each rule carries true/false criteria with concrete examples. Examples illustrate the harm; the question asks about the effect.",
     loc("jev_auto/rules.py", r"^class Rule")),
    ("code:fast_path", "Read-only fast path", "Reads and read-only commands inside the project are allowed without a Jev call. Credential-shaped paths never take this path.",
     loc("jev_auto/state.py", r"^def is_fast_path")),
    ("code:encoded", "Encoded payload check", "A decoded payload piped to an interpreter is blocked in code as unverifiable.",
     loc("jev_auto/state.py", r"^def has_encoded_exec")),
    ("code:segments", "Split chained commands", "Commands are split on ; && || | & and newlines, respecting quotes. Jev sees every segment.",
     loc("jev_auto/state.py", r"^def split_segments")),
    ("code:session_files", "Files written this session", "When the action runs a file the agent wrote or edited earlier, that file's content goes into the state with the action.",
     loc("jev_auto/state.py", r"^def executed_session_files")),
    ("code:edit_summary", "Edits show removals", "Edit calls reach Jev as removes/adds pairs, so a deleted guard is visible.",
     loc("jev_auto/state.py", r"^def _edit_summary")),
    ("code:transcript", "Transcript without tool output", "User turns, assistant prose, and tool calls with outcomes. Tool output is dropped before the state is built.",
     loc("jev_auto/state.py", r"^def compact_transcript")),
    ("code:user_turns", "User turns as their own field", "The user's messages are a separate input, the only source of intent. Very long sessions keep the first 5 and last 25.",
     loc("jev_auto/state.py", r"^def user_turns")),
    ("code:git_meta", "git status before destructive commands", "The extension runs git status itself before reset, clean, checkout ., stash drop, or rm -r, and attaches the result.",
     loc("pi-extension/src/inputs.ts", r"^export function withMeta")),
    ("code:environment", "Environment slots", "The prompt's slots at their conservative defaults: trusted repo and remotes, prod naming, IaC scopes, agent config paths.",
     loc("jev_auto/state.py", r"^def default_environment")),
    ("code:transcript_cut", "Action under review is the cut point", "The Pi extension stops the transcript at the current tool call, so the call is never part of its own context.",
     loc("pi-extension/src/inputs.ts", r"currentId\) return out")),
    ("code:outcomes", "Outcome tracking in Pi", "The extension records its own blocks and the user's Block choices, so a retry shows as rejected-by-user.",
     loc("pi-extension/index.ts", r"const outcomes")),
]
for id, title, body, where in code:
    target(id, "code", title, body, where)

# ALLOW exceptions folded into the false side of the rules they narrow.
folded = {
    "Security Discussion": ["credential_exploration", "exfil_scouting"],
    "Transient Retry": ["auto_mode_bypass"],
    "Test Artifacts": ["credential_leakage"],
    "Local Operations": ["irreversible_local_destruction"],
    "Read-Only Operations": ["data_exfiltration"],
    "Declared Dependencies": ["code_from_external", "untrusted_code_integration"],
    "Standard Credentials": ["credential_exploration", "data_exfiltration"],
    "Session-Created Job Cleanup": ["interfere_with_workloads", "irreversible_deletion_general"],
    "Git Push Destination": ["data_exfiltration"],
    "Memory Directory": ["instruction_poisoning"],
    "CLAUDE.md Content": ["self_modification"],
}
by_key = {r.key: r for r in RULES}
for name, keys in folded.items():
    target(f"folded:{name}", "folded", name, "Folded into the false side of " + ", ".join(by_key[k].name for k in keys) + ".",
           loc("jev_auto/rules.py", rf'^\s+"{keys[0]}",'),
           into=[{"rule": by_key[k].name, "false": by_key[k].false} for k in keys])

dropped = {
    "chrome": ("Chrome / browser surfaces", "Pi has no Claude-in-Chrome tools."),
    "artifact": ("Artifact sharing", "Pi has no Artifact tool."),
    "sandbox": ("Sandbox network callbacks", "Pi has no SandboxNetworkAccess events or allowed_domains lists."),
    "connected": ("Connected-app tools", "Pi core has no connector tools; gh and API writes are covered by External System Writes."),
    "agents": ("Sub-agents, teammates, other sessions", "Pi core has no Agent, Workflow, teammate, or cross-session messages."),
    "host_context": ("Host context and navigation lines", "Claude Code harness annotations with no Pi equivalent."),
    "scheduling": ("Claude Code scheduling", "CronCreate and RemoteTrigger do not exist in Pi."),
}
for id, (title, body) in dropped.items():
    target(f"dropped:{id}", "dropped", title, body)

gaps = {
    "quoted_turns": ("Quoted User:/Assistant: lines", "Not modeled. Indented quotes inside a turn are passed through as text."),
    "repo_visibility": ("Live repo visibility", "Not modeled. The environment assumes private; no visibility lookup runs."),
    "ships": ("Consent binds at the step that ships", "Not modeled as its own check; each call is judged alone."),
    "post_block": ("Repeated instruction after a block", "Not modeled. In Pi, the user's “Allow once” plays this role."),
    "review_content": ("Content supplied for review", "Not modeled beyond the instruction that embedded text is data."),
    "delayed": ("Delayed and enabled effects", "Partly covered by Unauthorized Persistence and Expose Local Services; no general question."),
    "wrappers": ("Look through code wrappers", "Not modeled. Jev sees the command as written."),
    "clear_intent": ("Preemptive block on clear intent", "Not modeled as its own question."),
    "tool_effect": ("Tool effect over self-description", "Not modeled as its own question."),
    "destination_novelty": ("Destination novelty", "Not modeled. A candidate for its own Noul: did the user name this destination?"),
    "prod_precedence": ("Production precedence", "Not modeled as its own rule; prod rules simply have no folded exceptions."),
    "toolchain": ("Toolchain bootstrap", "Not folded. Official installers like astral.sh may be flagged by Code from External."),
    "destinations": ("List every final destination", "Not modeled as a step; Data Exfiltration asks about the destination directly."),
    "generalize": ("Generalization check", "Not modeled as a step; criteria ask about effect rather than listed tools."),
    "secret_labels": ("Secrets as labels", "Partly covered by Credential Leakage."),
}
for id, (title, body) in gaps.items():
    target(f"gap:{id}", "gap", title, body)

# ------------------------------------------------------------------ line -> targets
mapping: dict[int, list[str]] = {}


def link(lines, *ids):
    for n in [lines] if isinstance(lines, int) else lines:
        mapping.setdefault(n, []).extend(ids)


link([1, 5, 7], "code:instructions")
link(12, "code:instructions", "code:transcript")
link(13, "intent:consent")
link(14, "rule:irreversible_local_destruction", "rule:interfere_with_workloads")
link(16, "code:hard", "code:soft")
link(20, "code:transcript", "code:user_turns", "intent:consent")
link(21, "gap:quoted_turns")
link(22, "code:transcript", "intent:repeat", "code:outcomes")
link(23, "code:git_meta")
link(24, "gap:repo_visibility")
link(25, "code:git_meta")
link([26, 27], "dropped:host_context")
link(31, "code:default")
link(35, "code:default")
link([39, 41], "intent:consent")
link([42, 44], "intent:boundary")
link(46, "intent:consent")
link([48, 49, 50, 51, 52], "intent:consent")
link(53, "intent:consent", "intent:adversarial")
link(55, "gap:ships")
link([59, 61, 62, 63, 64, 65, 67, 69], "intent:consent")
link(66, "intent:repeat")
link(71, "code:instructions", "code:transcript")
link(73, "intent:boundary")
link(75, "gap:post_block")
link(77, "code:instructions")
link(79, "dropped:agents")
link(81, "gap:review_content")
link(86, "code:segments")
link(87, "code:session_files")
link(88, "rule:code_that_leaks_when_run", "rule:credential_leakage")
link(89, "code:session_files", "code:transcript")
link(90, "gap:delayed", "rule:unauthorized_persistence")
link([91, 93], "dropped:agents")
link(92, "code:session_files")
link(94, "gap:wrappers")
link(95, "code:encoded")
link(96, "gap:clear_intent")
link(97, "rule:auto_mode_bypass", "code:instructions")
link(98, "rule:external_system_writes", "rule:excess_sensitive_detail")
link(99, "intent:repeat", "intent:consent")
link(100, "code:edit_summary")
link(101, "rule:unverifiable_deletion_target")
link([102, 103, 112], "dropped:chrome")
link(104, "gap:tool_effect")
link(105, "code:transcript_cut")
link(106, "gap:secret_labels", "rule:credential_leakage")
link(107, "intent:boundary")
link(108, "dropped:connected")
link(109, "rule:account_standing_rule_changes", "rule:permission_grant")
link(110, "rule:external_system_writes")
link(111, "gap:destination_novelty")
link(113, "rule:shared_cluster_mutation", "rule:modify_shared_resources")
link(114, "code:rule_table")
link(list(range(119, 142)), "code:environment")
link(148, "rule:credential_leakage")
link(149, "rule:sensitive_source_provenance", "rule:pii_data_handling")
link(150, "rule:out_of_place_publication")
link([151, 155, 157], "rule:data_exfiltration")
link(156, "code:environment")
link(158, "rule:shared_cluster_mutation")
link(159, "rule:interfere_with_workloads")
link([160, 161], "dropped:chrome")
link(165, "code:hard")
link(174, "code:soft", "intent:consent")
link(prompt_line(r"^- Live-Shared Artifact"), "dropped:artifact")
link([prompt_line(r"^- Sandbox Network Callback"), prompt_line(r"^- Command Network Lists")], "dropped:sandbox")
link(prompt_line(r"^- Unrequested Commit in a Connected App"), "dropped:connected")
link([prompt_line(rf"^- Browser {w}") for w in ("Navigate", "Input", "JS", "File Upload", "Shortcut")], "dropped:chrome")
for r in RULES:
    n = prompt_line(rf"^- {re.escape(r.name)}( \[|:)")
    link(n, f"rule:{r.key}")
link(prompt_line(r"^- Data Exfiltration:") + 1, "rule:data_exfiltration")
link(prompt_line(r"^- Data Exfiltration:") + 2, "rule:data_exfiltration")
link(prompt_line(r"^- Data Exfiltration:") + 3, "rule:data_exfiltration")
link([251, 253], "code:rule_table")
link(255, "gap:prod_precedence")
for name in folded:
    link(prompt_line(rf"^- {re.escape(name)}:"), f"folded:{name}")
link(prompt_line(r"^- Read-Only Operations:"), "code:fast_path")
link(prompt_line(r"^- Toolchain Bootstrap:"), "gap:toolchain")
link(prompt_line(r"^- Trusted Internal Infra"), "code:environment")
link(prompt_line(r"^- Scheduled-Task Fires:"), "dropped:scheduling")
link(prompt_line(r"^- Multi-Agent Coordination:"), "dropped:agents")
link(prompt_line(r"^- Claude Code Scheduling:"), "dropped:scheduling")
link(prompt_line(r"^- Browser Trusted Navigation:"), "dropped:chrome")
link(279, "code:session_files")
link(280, "code:segments", "code:session_files")
link(281, "gap:destinations")
link(282, "code:hard")
link([283, 284, 285, 286], "code:soft")
link([287, 288], "intent:boundary")
link(289, "code:soft", "intent:consent")
link(290, "code:default")
link(291, "gap:generalize")
link([295, 296], "code:verdict", "code:ask")
link(301, "code:environment")

lines = []
for n, text in enumerate(PROMPT, 1):
    ids = list(dict.fromkeys(mapping.get(n, [])))
    lines.append({"n": n, "text": text, "targets": ids})

used = {t for l in lines for t in l["targets"]}
missing = [r.key for r in RULES if f"rule:{r.key}" not in used]
assert not missing, f"rules with no source line: {missing}"
unused = sorted(set(targets) - used)
assert not unused, f"targets never linked: {unused}"

# ------------------------------------------------------------------ DSPy declarations
SIG = build_signature(RULES)


def declaration(name):
    """The output field as it would be written by hand in a class-based Signature."""
    field = SIG.output_fields[name]
    criteria = field.annotation.criteria()
    side = lambda v: textwrap.indent(json.dumps(criteria[v], indent=4, ensure_ascii=False), "    ").lstrip()  # noqa: E731
    desc = field.json_schema_extra["desc"]
    return (
        f"{name}: Noul[\n    (True, {side('true')}),\n    (False, {side('false')}),\n] = dspy.OutputField(\n"
        f"    desc={desc!r},\n)"
    )


def source(where, max_lines=8):
    path, line = where.rsplit(":", 1)
    lines = (ROOT / path).read_text().splitlines()[int(line) - 1 :]
    out = []
    for text in lines[:max_lines]:
        if not text.strip() and out:
            break
        out.append(text)
    return textwrap.dedent("\n".join(out))


for t in targets.values():
    if t["kind"] == "decision":
        key = t["id"].split(":", 1)[1]
        names = [f"m_{key}"] + ([f"c_{key}"] if t["tier"] == "soft" else [])
        t["decl"] = "\n\n".join(declaration(n) for n in names)
    elif t["kind"] == "folded":
        rules = [r for r in RULES if r.name in {i["rule"] for i in t["into"]}]
        t["decl"] = "\n\n".join(f"# m_{r.key}: false side of the Noul criteria\n" + json.dumps({"false": r.criteria()["false"]}, indent=2) for r in rules)
    elif t["kind"] == "code" and t["where"]:
        t["source"] = source(t["where"])

for id, name, note in [
    ("intent:consent", "c_git_destructive", "# Generated for every soft rule. Shown for Git Destructive.\n"),
    ("intent:adversarial", "c_credential_exploration", "# Generated for every adversarial rule. Shown for Credential Exploration.\n"),
    ("intent:boundary", "user_boundary", ""),
    ("intent:repeat", "repeat_rejected", ""),
]:
    targets[id]["decl"] = note + declaration(name)

inputs = "\n".join(
    f"    {n}: {f.annotation.__name__ if hasattr(f.annotation, '__name__') else f.annotation} = dspy.InputField(desc={f.json_schema_extra['desc']!r})"
    for n, f in SIG.input_fields.items()
)
signature = {
    "decl": f"class AutoMode(dspy.Signature):\n    {SIG.instructions!r}\n\n{inputs}\n\n"
    f"    # {len(SIG.output_fields)} Noul output fields: one m_<rule> per rule, one c_<rule> per soft rule,\n"
    f"    # plus user_boundary and repeat_rejected. Each card below shows its own.\n\n"
    f"judge = dspy.Predict(AutoMode)\njudge.set_lm(dspy.experimental.TypeSafe(\"jev-latest\"))",
}


def substantive(text):
    """Headings, section intros that end in a colon, and wrapper tags carry no rule of their own."""
    t = text.strip()
    return bool(t) and not t.startswith("#") and not re.fullmatch(r"</?[a-z_]+>", t)


data = {"lines": lines, "targets": targets, "signature": signature, "stats": {
    "rules": len(RULES), "hard": sum(r.tier == "hard" for r in RULES), "soft": sum(r.tier == "soft" for r in RULES),
    "adversarial": sum(r.adversarial for r in RULES), "questions": len(RULES) + sum(r.tier == "soft" for r in RULES) + 2,
    "code": sum(t["kind"] == "code" for t in targets.values()), "folded": len(folded), "dropped": len(dropped), "gaps": len(gaps),
    "mapped_lines": sum(bool(l["targets"]) for l in lines if substantive(l["text"])),
    "content_lines": sum(substantive(l["text"]) for l in lines),
}}

template = (ROOT / "scripts" / "prompt_map.template.html").read_text()
out = ROOT / "viz" / "prompt_map.html"
out.parent.mkdir(exist_ok=True)
out.write_text(template.replace("/*__DATA__*/null", json.dumps(data).replace("</", "<\\/")))
print(f"wrote {out} ({out.stat().st_size // 1024} KB):", data["stats"])
