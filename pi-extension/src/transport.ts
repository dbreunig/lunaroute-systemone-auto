/**
 * How a classifier gets called. Pi's model registry is the normal path. For System One models whose
 * provider hook cannot load Pi's System One adapter (@lunaroute/pi-extension 0.14.1 imports it by a
 * subpath Pi's loader cannot resolve), the request goes straight to the provider's /systemone
 * endpoint with the auth Pi resolves for that model. Delete the fallback once providers ship a fix.
 *
 * Models cap requests: djev takes at most 32 questions and about 4k input tokens, whatever its
 * catalog context says. Both caps are learned from the model's rejections, and the questions go out
 * in parallel batches that share the same state. A state too large for any question is an error,
 * which the monitor turns into ask.
 */

import type { ClassifierReply, Classify, PiRequest } from "./monitor.ts";

const SYSTEM_ONE_API = "typesafe-system-one";
const ADAPTER_MISSING = /Cannot find module/;

export interface ClassifierModel {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
  contextWindow?: number;
}

/** The parts of Pi's ModelRegistry this module uses. */
export interface Registry {
  classify(model: never, request: never, options: { signal: AbortSignal }): Promise<unknown>;
  getApiKeyAndHeaders(model: never): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string } | { ok: false; error: string }
  >;
}

const QUESTION_LIMIT = /max_questions of (\d+)/;
const INVALID_REQUEST = /rejected the request as invalid/;
// Bytes per token for budgeting. djev measured 4.4 on this program; lower is safer.
const CHARS_PER_TOKEN = 3.8;
const SHRINK = 0.75;
const MAX_ATTEMPTS = 8;

// UTF-8 bytes, not UTF-16 length: non-ASCII text costs more tokens per character.
const estimate = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / CHARS_PER_TOKEN);

export function makeClassifier(registry: Registry, model: ClassifierModel, fetchImpl: typeof fetch = fetch): Classify {
  let direct = false; // set once the provider's adapter is known to be broken
  let limit = Number.POSITIVE_INFINITY; // questions per request, learned from the model's rejection
  let budget = model.contextWindow ?? Number.POSITIVE_INFINITY; // input tokens per request, learned the same way
  let proven = 0; // largest estimated request the model has accepted; the budget never shrinks below it

  const once: Classify = async (request, signal) => {
    if (!direct) {
      const reply = (await registry.classify(model as never, request as never, { signal })) as ClassifierReply;
      const broken = reply.stopReason === "error" && model.api === SYSTEM_ONE_API && ADAPTER_MISSING.test(reply.errorMessage ?? "");
      if (!broken) return reply;
      direct = true;
    }
    return systemOne(registry, model, request, signal, fetchImpl);
  };

  return async (request, signal) => {
    let reply: ClassifierReply = { stopReason: "error", errorMessage: "no attempt made" };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const parts = pack(request, limit, budget);
      if (typeof parts === "string") return { stopReason: "error", errorMessage: `${model.provider}/${model.id}: ${parts}` };
      reply = parts.length === 1 ? await once(parts[0], signal) : await batched(once, parts, signal);
      if (reply.stopReason === "stop") proven = Math.max(proven, ...parts.map(estimate));
      if (reply.stopReason !== "error") return reply;
      const message = reply.errorMessage ?? "";
      // Another call may have learned the same cap meanwhile, so compare against what was sent.
      const learned = Number(QUESTION_LIMIT.exec(message)?.[1]);
      const sent = Math.max(...parts.map((part) => Object.keys(part.questions).length));
      if (learned > 0 && learned < sent) limit = Math.min(limit, learned);
      else if (INVALID_REQUEST.test(message) && Math.max(...parts.map(estimate)) > proven) {
        // Only a size the model has never accepted can be the problem; otherwise surface the error.
        budget = Math.max(proven, Math.min(budget, Math.floor(Math.max(...parts.map(estimate)) * SHRINK)));
      } else return reply;
    }
    return reply;
  };
}

/** Split the questions into requests that share the state, each within the question limit and token budget. */
function pack(request: PiRequest, limit: number, budget: number): PiRequest[] | string {
  const base = estimate({ state: request.state, questions: {} });
  const parts: PiRequest[] = [];
  let current: [string, unknown][] = [];
  let size = base;
  for (const entry of Object.entries(request.questions)) {
    const cost = estimate({ [entry[0]]: entry[1] });
    if (base + cost > budget) {
      return `the state is about ${base} tokens and this model accepts about ${budget} per request, so no question fits`;
    }
    if (current.length && (current.length >= limit || size + cost > budget)) {
      parts.push({ state: request.state, questions: Object.fromEntries(current) as PiRequest["questions"] });
      current = [];
      size = base;
    }
    current.push(entry);
    size += cost;
  }
  if (current.length) parts.push({ state: request.state, questions: Object.fromEntries(current) as PiRequest["questions"] });
  return parts;
}

/** Parallel requests; any failed batch fails the call. */
async function batched(once: Classify, parts: PiRequest[], signal: AbortSignal): Promise<ClassifierReply> {
  const replies = await Promise.all(parts.map((part) => once(part, signal)));
  const failed = replies.find((r) => r.stopReason !== "stop");
  if (failed) return failed;
  const inputs = replies.map((r) => r.usage?.input).filter((n): n is number => typeof n === "number");
  return {
    stopReason: "stop",
    answers: Object.assign({}, ...replies.map((r) => r.answers ?? {})),
    ...(inputs.length ? { usage: { input: inputs.reduce((a, b) => a + b, 0) } } : {}),
  };
}

async function systemOne(
  registry: Registry,
  model: ClassifierModel,
  request: PiRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ClassifierReply> {
  try {
    const auth = await registry.getApiKeyAndHeaders(model as never);
    if (!auth.ok) return { stopReason: "error", errorMessage: auth.error };
    const headers: Record<string, string> = { "content-type": "application/json", ...(auth.headers ?? {}) };
    const hasAuthorization = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
    if (!hasAuthorization && auth.apiKey) headers.authorization = `Bearer ${auth.apiKey}`;
    const base = (auth.baseUrl ?? model.baseUrl ?? "").replace(/\/+$/, "");
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { ...q, type: "noul" }]));
    const res = await fetchImpl(new URL("systemone", `${base}/`), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: model.id, state: request.state, questions }),
      signal,
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { stopReason: "error", errorMessage: `System One ${res.status}: ${body?.error?.message ?? res.statusText}` };
    const answers = Object.fromEntries(
      Object.entries(body.answers ?? {}).map(([name, a]: [string, any]) => [
        name,
        a?.type === "noul" && typeof a.noul === "number" ? { type: "bool", probability: a.noul } : { type: String(a?.type) },
      ]),
    );
    const input = body.usage?.input_tokens;
    return { stopReason: "stop", answers, ...(typeof input === "number" ? { usage: { input } } : {}) };
  } catch (e: any) {
    return { stopReason: signal.aborted ? "aborted" : "error", errorMessage: e?.message ?? String(e) };
  }
}
