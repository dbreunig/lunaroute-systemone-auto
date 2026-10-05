/**
 * Jev auto-mode monitor for Pi.
 *
 * Every tool call goes to a Python sidecar (jev_auto.server) that runs the DSPy program: code
 * prechecks, then one TypeSafe Jev request with a question per auto-mode rule. The verdict is
 * allow, block, or ask. HARD blocks never reach the user; soft blocks and unsure answers prompt
 * in the TUI (mode "ask") or go back to the agent with the reason (mode "auto", and always when
 * there is no UI). Any monitor failure fails closed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HOME = process.env.JEV_AUTO_HOME ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = Number(process.env.JEV_AUTO_TIMEOUT_MS ?? 45000);

type Verdict = { decision: "allow" | "block" | "ask"; rules: string[]; reason: string; source: string; hard: boolean };
type Entry = { role: "user" | "assistant" | "tool"; text?: string; tool?: string; input?: unknown; outcome?: string; id?: string };

class Sidecar {
	private proc?: ChildProcess;
	private ready?: Promise<void>;
	private pending = new Map<string, (v: Verdict) => void>();
	private seq = 0;
	private stderr: string[] = [];

	start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = new Promise((resolve, reject) => {
			const proc = spawn("uv", ["run", "--project", HOME, "python", "-m", "jev_auto.server"], {
				cwd: HOME,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.proc = proc;
			proc.stderr?.on("data", (d) => this.stderr.push(String(d)) && this.stderr.splice(0, this.stderr.length - 20));
			proc.on("exit", (code) => {
				const reason = `monitor exited (${code}): ${this.stderr.join("").slice(-400)}`;
				for (const done of this.pending.values()) done({ decision: "ask", rules: [], reason, source: "error", hard: false });
				this.pending.clear();
				this.proc = undefined;
				this.ready = undefined;
				reject(new Error(reason));
			});
			createInterface({ input: proc.stdout! }).on("line", (line) => {
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				if (msg.ready) return resolve();
				this.pending.get(msg.id)?.(msg);
				this.pending.delete(msg.id);
			});
		});
		return this.ready;
	}

	async judge(payload: object, signal?: AbortSignal): Promise<Verdict> {
		await this.start();
		const id = String(++this.seq);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`monitor timed out after ${TIMEOUT_MS}ms`));
			}, TIMEOUT_MS);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error("aborted"));
			});
			this.pending.set(id, (v) => {
				clearTimeout(timer);
				resolve(v);
			});
			this.proc!.stdin!.write(`${JSON.stringify({ id, ...payload })}\n`);
		});
	}

	stop() {
		this.proc?.kill();
		this.proc = undefined;
		this.ready = undefined;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text)
		.join("\n");
}

/** Reduce the session branch to user turns, assistant prose, and tool calls with outcomes. Tool output is dropped. */
function transcript(ctx: ExtensionContext, currentId: string, outcomes: Map<string, string>): Entry[] {
	const out: Entry[] = [];
	const byId = new Map<string, Entry>();
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "user") out.push({ role: "user", text: textOf(m.content) });
		else if (m.role === "assistant") {
			const text = textOf(m.content);
			if (text) out.push({ role: "assistant", text });
			for (const block of m.content ?? []) {
				if (block.type !== "toolCall") continue;
				if (block.id === currentId) return out; // the action under review is never part of its own context
				const call: Entry = { role: "tool", tool: block.name, input: block.arguments, id: block.id };
				byId.set(block.id, call);
				out.push(call);
			}
		} else if (m.role === "toolResult") {
			const call = byId.get(m.toolCallId);
			if (call) call.outcome = outcomes.get(m.toolCallId) ?? (m.isError ? "error" : "ok");
		}
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	const sidecar = new Sidecar();
	const outcomes = new Map<string, string>(); // our own decisions, so retries of rejected calls are visible
	let enabled = true;

	pi.registerFlag("jev-auto-mode", {
		description: "Jev monitor on soft blocks: 'ask' prompts you in the TUI, 'auto' returns the reason to the agent",
		type: "string",
		default: "ask",
	});

	pi.on("session_start", async (_event, ctx) => {
		sidecar.start().catch((e) => ctx.hasUI && ctx.ui.notify(`jev-auto: ${e.message}`, "error"));
		if (ctx.hasUI) ctx.ui.setStatus("jev-auto", "jev: on");
	});

	pi.on("session_shutdown", async () => sidecar.stop());

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		let v: Verdict;
		try {
			v = await sidecar.judge(
				{ transcript: transcript(ctx, event.toolCallId, outcomes), action: { tool: event.toolName, input: event.input }, cwd: ctx.cwd },
				ctx.signal,
			);
		} catch (e: any) {
			v = { decision: "ask", rules: [], reason: `Monitor unavailable: ${e.message}`, source: "error", hard: false };
		}
		if (ctx.hasUI) ctx.ui.setStatus("jev-auto", `jev: ${v.decision}${v.rules.length ? ` (${v.rules.join(", ")})` : ""}`);
		if (v.decision === "allow") return undefined;

		const prompt = ctx.hasUI && !v.hard && pi.getFlag("jev-auto-mode") !== "auto";
		if (prompt) {
			const summary = JSON.stringify(event.input).slice(0, 600);
			const choice = await ctx.ui.select(
				`Jev auto-mode: ${v.decision.toUpperCase()} ${event.toolName}\n\n  ${summary}\n\n${v.reason}`,
				["Block", "Allow once"],
			);
			if (choice === "Allow once") return undefined;
			outcomes.set(event.toolCallId, "rejected-by-user");
			return { block: true, reason: `The user declined this after the auto-mode monitor flagged it: ${v.reason}` };
		}
		outcomes.set(event.toolCallId, "automode-blocked");
		const rules = v.rules.length ? ` [${v.rules.join(", ")}]` : "";
		return { block: true, reason: `Auto-mode monitor blocked this${rules}. ${v.reason} Ask the user before retrying.` };
	});

	pi.registerCommand("jev-auto", {
		description: "Jev auto-mode monitor: on, off, or status",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on" || arg === "off") enabled = arg === "on";
			ctx.ui.setStatus("jev-auto", `jev: ${enabled ? "on" : "off"}`);
			ctx.ui.notify(`jev-auto is ${enabled ? "on" : "off"} (mode: ${pi.getFlag("jev-auto-mode")}, home: ${HOME})`, "info");
		},
	});
}
