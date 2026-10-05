"""The batching client: same packing as the TypeScript transport, answers merged, every question asked once."""

import json
import math

import pytest

from jev_auto.clients import KNOWN_CAPS, Batched, estimate, pack


def q(i, size=200):
    return {"instructions": f"Question {i}? " + "x" * size, "type": "noul", "criteria": {"true": {"what": "yes"}, "false": {"what": "no"}}}


STATE = {"instructions": "i", "input_fields": "f", "inputs": {"action": {"tool": "bash", "command": "ls"}}}
QUESTIONS = {f"q{i}": q(i) for i in range(70)}


class Recorder:
    supports_decision_requests = True

    def __init__(self):
        self.calls = []

    def __call__(self, state, questions):
        self.calls.append((state, list(questions)))
        return {name: {"noul": 0.2} for name in questions}


def test_estimate_counts_utf8_bytes_of_compact_json():
    assert estimate({"a": "漢"}) == math.ceil(len('{"a":"漢"}'.encode()) / 3.8)


def test_pack_respects_question_limit_and_budget():
    parts = pack(STATE, QUESTIONS, max_questions=32, token_budget=1200)
    assert [n for p in parts for n in p] == list(QUESTIONS)
    base = estimate({"state": STATE, "questions": {}})
    for p in parts:
        assert len(p) <= 32
        assert base + sum(estimate({n: QUESTIONS[n]}) for n in p) <= 1200


def test_pack_refuses_a_state_too_large_for_any_question():
    big = {**STATE, "inputs": {"transcript": "x" * 20000}}
    with pytest.raises(ValueError, match="no question fits"):
        pack(big, QUESTIONS, max_questions=32, token_budget=2000)


def test_batched_asks_every_question_once_with_the_same_state():
    inner = Recorder()
    answers = Batched(inner, max_questions=32, token_budget=1200)(state=STATE, questions=QUESTIONS)
    assert set(answers) == set(QUESTIONS)
    assert all(state is STATE for state, _ in inner.calls)
    assert sorted(n for _, names in inner.calls for n in names) == sorted(QUESTIONS)
    assert len(inner.calls) > 2


def test_djev_caps_are_declared():
    assert KNOWN_CAPS["lunaroute/djev"] == {"max_questions": 8, "token_budget": 4000}


class TypeSafeRateLimitError(Exception):
    pass


def test_retrying_waits_out_rate_limits_and_reraises_other_errors():
    from jev_auto.clients import Retrying

    calls, sleeps = [], []

    def flaky(state, questions):
        calls.append(1)
        if len(calls) < 3:
            raise TypeSafeRateLimitError("429")
        return {"q": {"noul": 0.4}}

    client = Retrying(flaky, attempts=5, base_delay=1.0, sleep=sleeps.append)
    assert client(state={}, questions={"q": {}}) == {"q": {"noul": 0.4}}
    assert sleeps == [1.0, 2.0]

    def broken(state, questions):
        raise ValueError("bad request")

    with pytest.raises(ValueError):
        Retrying(broken, sleep=sleeps.append)(state={}, questions={})
