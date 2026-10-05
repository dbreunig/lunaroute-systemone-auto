"""Decision clients for System One models with per-request caps.

djev accepts at most 32 questions and about 4k input tokens per request, so the 127 questions go out
in batches that share the state. The packing matches pi-extension/src/transport.ts exactly, so the
DSPy benchmark and the Pi extension ask the same questions in the same groups.
"""

import json
import math

# Bytes per token for budgeting. djev measured 4.4 on this program; lower is safer.
BYTES_PER_TOKEN = 3.8

# Caps for models whose limits are known, keyed provider/id. Exported to the TypeScript extension.
# djev: 8 questions per request measured best on dev (89.1% exact vs 85.9% at 16 and 32, and the only
# sizes with no false allows were 8 and 16); its hard ceiling is 32.
KNOWN_CAPS = {"lunaroute/djev": {"max_questions": 8, "token_budget": 4000}}


def estimate(value) -> int:
    """Estimated tokens: UTF-8 bytes of compact JSON, as JavaScript's JSON.stringify writes it."""
    return math.ceil(len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()) / BYTES_PER_TOKEN)


def pack(state: dict, questions: dict, max_questions: int, token_budget: int) -> list[list[str]]:
    """Group question names into requests within the question limit and token budget, in order."""
    base = estimate({"state": state, "questions": {}})
    parts, current, size = [], [], base
    for name, question in questions.items():
        cost = estimate({name: question})
        if base + cost > token_budget:
            raise ValueError(f"the state is about {base} tokens and this model accepts about {token_budget} per request, so no question fits")
        if current and (len(current) >= max_questions or size + cost > token_budget):
            parts.append(current)
            current, size = [], base
        current.append(name)
        size += cost
    if current:
        parts.append(current)
    return parts


class Batched:
    """Wrap a decision client so each request stays within a model's caps; answers are merged."""

    supports_decision_requests = True

    def __init__(self, inner, max_questions: int, token_budget: int):
        self.inner = inner
        self.max_questions = max_questions
        self.token_budget = token_budget

    def __call__(self, state, questions):
        answers = {}
        for names in pack(state, questions, self.max_questions, self.token_budget):
            answers.update(self.inner(state=state, questions={n: questions[n] for n in names}))
        return answers


class Retrying:
    """Retry a decision client on rate limits with exponential backoff (benchmarks only).

    The Pi extension does not retry: a rate-limited call fails closed to ask.
    """

    supports_decision_requests = True

    def __init__(self, inner, attempts: int = 8, base_delay: float = 5.0, sleep=None):
        import time

        self.inner = inner
        self.attempts = attempts
        self.base_delay = base_delay
        self.sleep = sleep or time.sleep

    def __call__(self, state, questions):
        for attempt in range(self.attempts):
            try:
                return self.inner(state=state, questions=questions)
            except Exception as e:  # noqa: BLE001 - only rate limits are retried
                if "RateLimit" not in type(e).__name__ or attempt == self.attempts - 1:
                    raise
                self.sleep(self.base_delay * 2**attempt)
        raise AssertionError("unreachable")
