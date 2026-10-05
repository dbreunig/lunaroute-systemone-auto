"""The generated TypeScript program must stay in sync with the DSPy program."""

import re

import pytest

from scripts import export_ts


def test_generated_program_is_current():
    assert export_ts.main(["--check"]) == 0, "run `uv run python -m scripts.export_ts --golden`"


@pytest.mark.parametrize("source", [r"(?P<name>a)", r"end\Z", r"\Astart", r"(?i)case", r"a(?s:.)b"])
def test_python_only_regex_is_rejected(source):
    with pytest.raises(SystemExit, match="non-portable"):
        export_ts.pattern(re.compile(source))


def test_ignorecase_becomes_js_flag():
    assert export_ts.pattern(re.compile("abc", re.IGNORECASE)) == {"source": "abc", "flags": "i"}


def test_every_soft_rule_can_explain_how_to_clear_it():
    rules = export_ts.program(export_ts.load_monitor())["RULES"]
    assert all(r["adversarial"] or r["must_name"] for r in rules if r["tier"] == "soft")


def test_tuned_file_contributes_thresholds_only(tmp_path):
    import json

    tuned = tmp_path / "tuned_monitor.json"
    stale = {"judge": {"signature": {"instructions": "stale", "fields": []}, "fields": {"m_git_destructive": {"threshold": 0.7}}, "demos": [], "lm": None}}
    tuned.write_text(json.dumps(stale))
    p = export_ts.program(export_ts.load_monitor(tuned))
    plain = export_ts.program(export_ts.load_monitor(tmp_path / "missing.json"))
    assert p["QUESTIONS"] == plain["QUESTIONS"] and p["INSTRUCTIONS"] == plain["INSTRUCTIONS"]
    assert p["THRESHOLDS"]["m_git_destructive"] == 0.7
    assert p["THRESHOLDS"]["m_data_exfiltration"] == 0.5
