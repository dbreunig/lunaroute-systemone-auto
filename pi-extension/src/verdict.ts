import { RULES } from "./program.generated.ts";

export type Decision = "allow" | "block" | "ask";
export type Source = "code" | "fast_path" | "model" | "error";

export interface Verdict {
  decision: Decision;
  source: Source;
  rules: string[];
  reason: string;
  /** A HARD rule blocked it: never offered to the user to override. */
  hard: boolean;
}

const TIER = new Map(RULES.map((r) => [r.key, r.tier]));

export function verdict(decision: Decision, source: Source, rules: string[], reason: string): Verdict {
  const hard = decision === "block" && rules.some((k) => TIER.get(k) === "hard");
  return { decision, source, rules, reason, hard };
}
