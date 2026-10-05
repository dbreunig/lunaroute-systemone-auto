/** Which classifier the monitor uses: default lunaroute/djev, saved in Pi's agent directory. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_MODEL = "lunaroute/djev";
export const MIN_CONTEXT = 32768;
const SYSTEM_ONE_API = "typesafe-system-one";

export function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return process.env.SYSTEM_ONE_AUTO_SETTINGS ?? join(agentDir, "system-one-auto.json");
}

/** provider/id, split at the first slash: model ids may contain slashes. */
export function parseModel(ref: string): { provider: string; id: string } | undefined {
  const i = ref.indexOf("/");
  return i > 0 && i < ref.length - 1 ? { provider: ref.slice(0, i), id: ref.slice(i + 1) } : undefined;
}

export function readModel(path: string): string | undefined {
  try {
    const model = JSON.parse(readFileSync(path, "utf8")).model;
    return typeof model === "string" && parseModel(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

export function writeModel(path: string, model: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ model }, null, 2)}\n`);
}

export function modelWarnings(model: { api: string; contextWindow: number }): string[] {
  const warnings: string[] = [];
  if (model.contextWindow < MIN_CONTEXT) {
    warnings.push(`Context window ${model.contextWindow} is too small for this program (~24k-token requests); most calls will fail and ask.`);
  }
  if (model.api !== SYSTEM_ONE_API) {
    warnings.push(`${model.api} is not the System One API; how it handles this program's criteria is unverified, and calls may fall back to ask.`);
  }
  return warnings;
}
