/** Policy in code: a port of AutoModeMonitor.compose and DSPy's Noul decoding. */

import { ASK_FLOOR, RULES, type RuleInfo, THRESHOLDS } from "./program.generated.ts";
import { verdict, type Verdict } from "./verdict.ts";

export interface Noul {
  value: boolean;
  probability: number;
  confidence: number;
}

/** DSPy's DecisionState._decode for Noul fields: value at the threshold, confidence as distance from it. */
export function decode(probabilities: Record<string, unknown>): Record<string, Noul> {
  const out: Record<string, Noul> = {};
  for (const [name, threshold] of Object.entries(THRESHOLDS)) {
    const p = probabilities[name];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`missing or invalid answer for ${name}`);
    out[name] = { value: p >= threshold, probability: p, confidence: Math.abs(p - threshold) / Math.max(threshold, 1 - threshold) };
  }
  return out;
}

const keys = (rules: RuleInfo[]) => rules.map((r) => r.key);
const names = (rules: RuleInfo[]) => rules.map((r) => r.name).join(", ");

export function compose(a: Record<string, Noul>, askFloor: number = ASK_FLOOR): Verdict {
  const hits = RULES.filter((r) => a[r.match_field].value);
  const hard = hits.filter((r) => r.tier === "hard");
  if (hard.length) {
    return verdict("block", "model", keys(hard), `HARD block: ${names(hard)}. Run it outside auto mode to review it yourself.`);
  }
  if (a.user_boundary.value) return verdict("block", "model", ["user_boundary"], "The user set a boundary that covers this action.");
  if (a.repeat_rejected.value) return verdict("block", "model", ["repeat_rejected"], "The user rejected a similar action earlier.");

  const consent = (r: RuleInfo) => a[r.consent_field as string];
  const soft = hits.filter((r) => r.tier === "soft");
  const uncleared = soft.filter((r) => !consent(r).value);
  if (uncleared.length) {
    const clears = uncleared
      .map((r) => (r.adversarial ? `${r.name}: the user confirms it is a false positive` : `${r.name}: the user names ${r.must_name}`))
      .join("; ");
    const unsure = uncleared.filter((r) => a[r.match_field].confidence < askFloor || consent(r).confidence < askFloor);
    return verdict(unsure.length === uncleared.length ? "ask" : "block", "model", keys(uncleared), `Would clear if — ${clears}.`);
  }

  // Allowed, but the classifier was unsure about some rule. Ask rather than guess, unless the user's
  // consent already clears that rule: then whether it matched does not change the outcome.
  const covered = (r: RuleInfo) => r.tier === "soft" && consent(r).value;
  const unsure = RULES.filter((r) => !a[r.match_field].value && a[r.match_field].confidence < askFloor && !covered(r));
  if (unsure.length) return verdict("ask", "model", keys(unsure), `Unsure whether this matches: ${names(unsure)}.`);
  const cleared = keys(soft);
  return verdict("allow", "model", cleared, cleared.length ? "Cleared by user consent." : "No rule matched.");
}
