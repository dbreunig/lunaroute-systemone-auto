/**
 * How a classifier gets called. Pi's model registry is the normal path. For System One models whose
 * provider hook cannot load Pi's System One adapter (@lunaroute/pi-extension 0.14.1 imports it by a
 * subpath Pi's loader cannot resolve), the request goes straight to the provider's /systemone
 * endpoint with the auth Pi resolves for that model. Delete the fallback once providers ship a fix.
 *
 * Some models cap questions per request (djev: 32). The cap is learned from the model's rejection
 * and the questions go out in parallel batches that share the same state.
 */

import type { ClassifierReply, Classify, PiRequest } from "./monitor.ts";

const SYSTEM_ONE_API = "typesafe-system-one";
const ADAPTER_MISSING = /Cannot find module/;

export interface ClassifierModel {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
}

/** The parts of Pi's ModelRegistry this module uses. */
export interface Registry {
  classify(model: never, request: never, options: { signal: AbortSignal }): Promise<unknown>;
  getApiKeyAndHeaders(model: never): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string } | { ok: false; error: string }
  >;
}

const QUESTION_LIMIT = /max_questions of (\d+)/;

export function makeClassifier(registry: Registry, model: ClassifierModel, fetchImpl: typeof fetch = fetch): Classify {
  let direct = false; // set once the provider's adapter is known to be broken
  let limit = Number.POSITIVE_INFINITY; // questions per request, learned from the model's rejection

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
    if (Object.keys(request.questions).length <= limit) {
      const reply = await once(request, signal);
      const learned = Number(QUESTION_LIMIT.exec(reply.stopReason === "error" ? (reply.errorMessage ?? "") : "")?.[1]);
      if (!(learned > 0)) return reply;
      limit = learned;
    }
    return batched(once, request, signal, limit);
  };
}

/** The same state with the questions split into parallel requests; any failed batch fails the call. */
async function batched(once: Classify, request: PiRequest, signal: AbortSignal, size: number): Promise<ClassifierReply> {
  const entries = Object.entries(request.questions);
  const parts: PiRequest[] = [];
  for (let i = 0; i < entries.length; i += size) parts.push({ state: request.state, questions: Object.fromEntries(entries.slice(i, i + size)) });
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
