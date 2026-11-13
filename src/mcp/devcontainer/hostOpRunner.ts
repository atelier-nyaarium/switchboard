import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import {
	type DaemonHostOp,
	type HostAgentModelsResult,
	type HostClaudeCancelOp,
	type HostClaudeRunOp,
	type HostClaudeRunReply,
	type HostKasaScanResult,
	type HostListDirsResult,
	type HostOp,
	type HostPeekResult,
	type HostPurgeOp,
	type HostReadSkillResult,
	type HostWifiNetworkResult,
	type LegacyCreateSessionOp,
	type PromptDecision,
	type PromptOutcome,
	type PurgeOutcome,
	paneKey,
	type TmuxTarget,
	TYPED_GIVE_UP_MS,
	type TypeIntoPaneResult,
} from "../../shared/host-op.js";
import { createOpDedupe } from "../../shared/op-dedupe.js";
import { createSingleFlight } from "../../shared/single-flight.js";

export interface TmuxOps {
	peekPane: (target: TmuxTarget, resize?: boolean) => Promise<HostPeekResult>;
	sendText: (target: TmuxTarget, text: string, submit?: boolean) => Promise<void>;
	sendKey: (target: TmuxTarget, key: string) => Promise<void>;
	answerPrompt: (
		target: TmuxTarget,
		promptId: string,
		decision: PromptDecision,
		reason?: string,
	) => Promise<PromptOutcome>;
	// FIXME 2026-11-24: drop, once every Gateway creates by wake.
	createSession: (op: LegacyCreateSessionOp) => Promise<unknown>;
	reloadPlugins: (target: TmuxTarget) => Promise<unknown>;
	killSession: (target: TmuxTarget) => Promise<void>;
	purge?: (op: HostPurgeOp) => Promise<PurgeOutcome>;
	/** Queued, never awaited to its end. */
	containerStart: (project: string) => Promise<void>;
	containerStop: (project: string) => Promise<void>;
	listDirs: (path: string, spawn?: string) => Promise<HostListDirsResult>;
	readSkill: (target: AgentExecutionTarget, path: string) => Promise<HostReadSkillResult>;
	kasaScan: () => Promise<HostKasaScanResult>;
	wifiNetwork: () => Promise<HostWifiNetworkResult>;
	typeIntoPane: (target: TmuxTarget, text: string) => Promise<TypeIntoPaneResult>;
	agentModels?: (backend: AgentBackendId, target: AgentExecutionTarget) => Promise<HostAgentModelsResult>;
	claudeRun?: (op: HostClaudeRunOp) => HostClaudeRunReply;
	claudeCancel?: (op: HostClaudeCancelOp) => Promise<{ cancelled: boolean }>;
}

export type PeekPriority = "interactive" | "derive";

const MIN_PEEK_INTERVAL_MS = 300;
const MAX_CONCURRENT_PEEKS = 6;
const SEND_DEDUP_TTL_MS = 60_000;
/** Past one key's last retry. */
const TYPED_DEDUP_TTL_MS = TYPED_GIVE_UP_MS + 2 * 60_000;
/** Thrown so a joined flight's busy answer is not held. */
const PANE_BUSY = Symbol("pane busy");

const targetKey = paneKey;

export function createHostOpRunner(ops: TmuxOps, opts: { minPeekIntervalMs?: number; now?: () => number } = {}) {
	const minPeekIntervalMs = opts.minPeekIntervalMs ?? MIN_PEEK_INTERVAL_MS;
	const now = opts.now ?? (() => Date.now());
	const inflightPeeks = createSingleFlight<string, HostPeekResult>();
	const lastCapture = new Map<string, { at: number; result: HostPeekResult }>();
	const sendDedupe = createOpDedupe<unknown>({ now, holdMs: SEND_DEDUP_TTL_MS });
	const typedDedupe = createOpDedupe<unknown>({ now, holdMs: TYPED_DEDUP_TTL_MS });

	let activePeeks = 0;
	const interactiveWaiters: Array<() => void> = [];
	const deriveWaiters: Array<() => void> = [];
	// Interactive preempts derive; lanes FIFO.
	async function withPeekSlot<T>(priority: PeekPriority, fn: () => Promise<T>): Promise<T> {
		if (activePeeks >= MAX_CONCURRENT_PEEKS) {
			const queue = priority === "interactive" ? interactiveWaiters : deriveWaiters;
			await new Promise<void>((r) => queue.push(r));
		}
		activePeeks++;
		try {
			return await fn();
		} finally {
			activePeeks--;
			(interactiveWaiters.shift() ?? deriveWaiters.shift())?.();
		}
	}

	async function runPeek(
		target: TmuxTarget,
		peekOpts: { resize?: boolean; priority?: PeekPriority } = {},
	): Promise<HostPeekResult> {
		const { resize = true, priority = "interactive" } = peekOpts;
		const key = targetKey(target);
		const cached = lastCapture.get(key);
		if (cached && now() - cached.at < minPeekIntervalMs) return cached.result;
		return inflightPeeks.run(key, async () => {
			// Joiners inherit initiator resize.
			const result = await withPeekSlot(priority, () => ops.peekPane(target, resize));
			const completedAt = now();
			lastCapture.set(key, { at: completedAt, result });
			for (const [k, v] of lastCapture) if (completedAt - v.at >= minPeekIntervalMs) lastCapture.delete(k);
			return result;
		});
	}

	async function runDeduped(
		dedupKey: string | undefined,
		exec: () => Promise<unknown>,
		result: unknown,
	): Promise<unknown> {
		// No key: always execute.
		if (!dedupKey) {
			return (await exec()) ?? result;
		}
		return sendDedupe.once(dedupKey, async () => (await exec()) ?? result);
	}

	function runSend(op: Extract<HostOp, { kind: "sendText" | "sendKey" }>): Promise<unknown> {
		const exec = () =>
			op.kind === "sendText" ? ops.sendText(op.target, op.text, op.submit) : ops.sendKey(op.target, op.key);
		return runDeduped(op.dedupKey, exec, { sent: true });
	}

	/** A repeat of typed text replays; a busy answer is not held, so the retry waits again. */
	async function runTyping(op: Extract<HostOp, { kind: "typeIntoPane" }>): Promise<unknown> {
		if (!op.dedupKey) return ops.typeIntoPane(op.target, op.text);
		try {
			return await typedDedupe.once(op.dedupKey, async () => {
				const outcome = await ops.typeIntoPane(op.target, op.text);
				if (!outcome.typed) throw PANE_BUSY;
				return outcome;
			});
		} catch (error) {
			if (error === PANE_BUSY) return { typed: false, reason: "busy" };
			throw error;
		}
	}

	async function run(op: DaemonHostOp): Promise<unknown> {
		if (op.kind === "peek") return runPeek(op.target);
		if (op.kind === "kasaScan") return ops.kasaScan();
		if (op.kind === "wifiNetwork") return ops.wifiNetwork();
		if (op.kind === "typeIntoPane") return runTyping(op);
		if (op.kind === "sendText" || op.kind === "sendKey") return runSend(op);
		if (op.kind === "answerPrompt")
			return runDeduped(
				op.dedupKey,
				async () => ({ outcome: await ops.answerPrompt(op.target, op.promptId, op.decision, op.reason) }),
				null,
			);
		if (op.kind === "listDirs") return ops.listDirs(op.path, op.spawn);
		if (op.kind === "readSkill") return ops.readSkill(op.target, op.path);
		if (op.kind === "agentModels") {
			if (!ops.agentModels) throw new Error("agentModels unavailable");
			return ops.agentModels(op.backend, op.target);
		}
		if (op.kind === "claudeRun") {
			if (!ops.claudeRun) throw new Error("claudeRun unavailable");
			return ops.claudeRun(op);
		}
		if (op.kind === "claudeCancel") {
			if (!ops.claudeCancel) throw new Error("claudeCancel unavailable");
			return ops.claudeCancel(op);
		}
		if (op.kind === "createSession") return runDeduped(op.dedupKey, () => ops.createSession(op), { created: true });
		if (op.kind === "reloadPlugins")
			return runDeduped(op.dedupKey, () => ops.reloadPlugins(op.target), { initiated: true });
		if (op.kind === "killSession")
			return runDeduped(op.dedupKey, () => ops.killSession(op.target), { killed: true });
		if (op.kind === "purge") {
			if (!ops.purge) throw new Error("purge unavailable");
			return { outcome: await ops.purge(op) };
		}
		if (op.kind === "containerStart")
			return runDeduped(op.dedupKey, () => ops.containerStart(op.project), { accepted: true });
		if (op.kind === "containerStop")
			return runDeduped(op.dedupKey, () => ops.containerStop(op.project), { accepted: true });
		const unhandled: never = op;
		throw new Error(`unknown host op ${JSON.stringify(unhandled)}`);
	}

	return { run, peek: runPeek };
}
