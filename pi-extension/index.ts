/**
 * System One auto-mode monitor for Pi.
 *
 * Every tool call is judged in stages, cheapest first: code prechecks (encoded payloads block,
 * read-only calls inside the project allow), then one request to a System One classifier with a
 * question per auto-mode rule, then composition in code. The default classifier is lunaroute/djev
 * through the user's Lunaroute login in Pi; any classifier model can be chosen. The decision
 * program is exported from the DSPy monitor in jev_auto/ by scripts/export_ts.py.
 *
 * HARD blocks never reach the user. Soft blocks and unsure answers prompt in the TUI (mode "ask")
 * or go back to the agent with the reason (mode "auto", and always without a UI). Every failure
 * fails closed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { branchToEntries, environmentFor, withMeta } from "./src/inputs.ts";
import { CANCELLED, type Classify, decide } from "./src/monitor.ts";
import type { Action } from "./src/prechecks.ts";
import { DEFAULT_MODEL, modelWarnings, parseModel, readModel, settingsPath, writeModel } from "./src/settings.ts";
import { makeClassifier } from "./src/transport.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.SYSTEM_ONE_AUTO_TIMEOUT_MS ?? 10000);
const STATUS_KEY = "system-one-auto";

export default function (pi: ExtensionAPI) {
  const outcomes = new Map<string, string>(); // our own decisions, so retries of rejected calls are visible
  let enabled = true;
  let chosen: string | undefined; // picked with /system-one-auto model in this session
  const classifiers = new Map<string, Classify>();

  pi.registerFlag("system-one-auto-mode", {
    description: "System One auto-mode on soft blocks: 'ask' prompts you in the TUI, 'auto' returns the reason to the agent",
    type: "string",
    default: "ask",
  });
  pi.registerFlag("system-one-auto-model", {
    description: `Classifier model for System One auto-mode, as provider/id (default ${DEFAULT_MODEL})`,
    type: "string",
    default: "",
  });

  const activeModel = () => chosen || String(pi.getFlag("system-one-auto-model") || "") || readModel(settingsPath()) || DEFAULT_MODEL;

  const resolve = (ctx: ExtensionContext, ref: string) => {
    const parsed = parseModel(ref);
    return parsed ? ctx.modelRegistry.findOfType("classifier", parsed.provider, parsed.id) : undefined;
  };

  const status = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
  };

  pi.on("session_start", async (_event, ctx) => status(ctx, `system-one: on · ${activeModel()}`));

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;
    const ref = activeModel();
    const model = resolve(ctx, ref);
    let classifier: Classify | null = null;
    if (model) {
      classifier = classifiers.get(ref) ?? makeClassifier(ctx.modelRegistry as never, model);
      classifiers.set(ref, classifier); // keeps a known-broken provider adapter from being retried every call
    }
    const action: Action = { tool: event.toolName, input: (event.input ?? {}) as Record<string, unknown> };
    const v = await decide({
      action,
      cwd: ctx.cwd,
      model: ref,
      classifier,
      signal: ctx.signal,
      timeoutMs: TIMEOUT_MS,
      context: () => ({
        transcript: branchToEntries(ctx.sessionManager.getBranch() as unknown[], event.toolCallId, outcomes),
        environment: environmentFor(ctx.cwd, EXTENSION_DIR),
        action: withMeta(action, ctx.cwd),
      }),
    });
    status(ctx, `system-one: ${v.decision}${v.rules.length ? ` (${v.rules.join(", ")})` : ""} · ${ref}`);
    if (v.decision === "allow") return undefined;
    if (v.reason === CANCELLED) return { block: true, reason: CANCELLED };

    const prompt = ctx.hasUI && !v.hard && pi.getFlag("system-one-auto-mode") !== "auto";
    if (prompt) {
      const summary = JSON.stringify(event.input).slice(0, 600);
      const choice = await ctx.ui.select(
        `System One auto-mode: ${v.decision.toUpperCase()} ${event.toolName}\n\n  ${summary}\n\n${v.reason}`,
        ["Block", "Allow once"],
      );
      if (choice === "Allow once") return undefined;
      outcomes.set(event.toolCallId, "rejected-by-user");
      return { block: true, reason: `The user declined this after the System One auto-mode monitor flagged it: ${v.reason}` };
    }
    outcomes.set(event.toolCallId, "automode-blocked");
    const rules = v.rules.length ? ` [${v.rules.join(", ")}]` : "";
    return { block: true, reason: `System One auto-mode blocked this${rules}. ${v.reason} Ask the user before retrying.` };
  });

  async function chooseModel(ctx: ExtensionContext, ref?: string) {
    if (!ref) {
      const models = await ctx.modelRegistry.getAvailableOfType("classifier");
      if (!models.length) {
        ctx.ui.notify("No classifier models have working credentials in Pi.", "error");
        return;
      }
      const labels = models.map(
        (m) => `${m.provider}/${m.id} · ${m.api} · ${Math.round(m.contextWindow / 1024)}k${modelWarnings(m).length ? " · ⚠" : ""}`,
      );
      const picked = await ctx.ui.select(`Classifier for System One auto-mode (now ${activeModel()})`, labels);
      if (!picked) return;
      const m = models[labels.indexOf(picked)];
      ref = `${m.provider}/${m.id}`;
    }
    const model = resolve(ctx, ref);
    if (!model) {
      ctx.ui.notify(`${ref} is not a classifier model in Pi's catalog; keeping ${activeModel()}.`, "error");
      return;
    }
    chosen = ref;
    writeModel(settingsPath(), ref);
    const warnings = modelWarnings(model);
    ctx.ui.notify([`System One auto-mode now uses ${ref}.`, ...warnings].join("\n"), warnings.length ? "warning" : "info");
    status(ctx, `system-one: ${enabled ? "on" : "off"} · ${ref}`);
  }

  pi.registerCommand("system-one-auto", {
    description: "System One auto-mode monitor: on, off, status, or model [provider/id]",
    handler: async (args, ctx) => {
      const [verb, ref] = args.trim().split(/\s+/);
      if (verb === "model") return chooseModel(ctx, ref);
      if (verb === "on" || verb === "off") enabled = verb === "on";
      status(ctx, `system-one: ${enabled ? "on" : "off"} · ${activeModel()}`);
      ctx.ui.notify(`System One auto-mode is ${enabled ? "on" : "off"} (mode: ${pi.getFlag("system-one-auto-mode")}, model: ${activeModel()})`, "info");
    },
  });
}
