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
