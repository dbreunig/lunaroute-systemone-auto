/**
 * One tool call, judged in stages, cheapest first. Code prechecks decide without building any
 * context; only then is the session walked and the classifier called. Every failure fails closed.
 */

import { compose, decode } from "./compose.ts";
import { buildInputs, buildRequest, type DspyRequest, type Entry, type Environment } from "./inputs.ts";
import { type Action, precheck } from "./prechecks.ts";
import { verdict, type Verdict } from "./verdict.ts";

export interface ClassifierReply {
  stopReason: string;
  errorMessage?: string;
  answers?: Record<string, { type: string; probability?: number }>;
  usage?: { input?: number };
}

export interface PiRequest {
  state: DspyRequest["state"];
  questions: Record<string, { type: "bool"; instructions: string; criteria: unknown }>;
}

export type Classify = (request: PiRequest, signal: AbortSignal) => Promise<ClassifierReply>;

export const CANCELLED = "cancelled";
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface Call {
  action: Action;
  cwd: string;
  /** provider/id, for messages. */
  model: string;
  /** Null when the configured model is not a classifier in Pi's catalog. */
  classifier: Classify | null;
  /** Built only when no precheck decided. */
  context: () => { transcript: Entry[]; environment: Environment; action: Action };
  /** The user's turn signal. */
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Pi's classifier API names DSPy's "noul" questions "bool"; its System One adapter sends them back as "noul". */
export function toPiRequest(request: DspyRequest): PiRequest {
  const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { ...q, type: "bool" as const }]));
  return { state: request.state, questions };
}

export async function decide(call: Call): Promise<Verdict> {
  const early = precheck(call.action, call.cwd);
  if (early) return early;
  if (!call.classifier) {
    return verdict("ask", "error", [], `${call.model} is not a classifier in Pi's model catalog. Install and sign in to its provider, or pick another with /system-one-auto model.`);
  }

  // AbortSignal.timeout throws on these; a bad setting must still fail closed with a readable reason.
  if (!Number.isInteger(call.timeoutMs) || call.timeoutMs <= 0 || call.timeoutMs > MAX_TIMEOUT_MS) {
    return verdict("ask", "error", [], `SYSTEM_ONE_AUTO_TIMEOUT_MS must be a positive whole number of milliseconds (got ${call.timeoutMs}).`);
  }
  const { transcript, environment, action } = call.context();
  const request = toPiRequest(buildRequest(buildInputs(transcript, action, environment)));
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const signal = call.signal ? AbortSignal.any([timeout, call.signal]) : timeout;
  let reply: ClassifierReply;
  try {
    reply = await call.classifier(request, signal);
  } catch (e: any) {
    reply = { stopReason: "error", errorMessage: e?.message ?? String(e) };
  }

  if (call.signal?.aborted) return verdict("block", "error", [], CANCELLED);
  if (timeout.aborted) return verdict("ask", "error", [], `Classifier ${call.model} timed out after ${call.timeoutMs}ms.`);
  if (reply.stopReason !== "stop") return verdict("ask", "error", [], `Classifier ${call.model} failed: ${reply.errorMessage ?? reply.stopReason}`);
  const probabilities = Object.fromEntries(Object.entries(reply.answers ?? {}).map(([k, v]) => [k, v?.probability]));
  try {
    return compose(decode(probabilities));
  } catch (e: any) {
    return verdict("ask", "error", [], `Classifier ${call.model} returned an incomplete answer: ${e.message}`);
  }
}
