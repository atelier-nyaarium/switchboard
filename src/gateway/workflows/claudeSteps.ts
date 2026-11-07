import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import type { Ambient } from "../../shared/ambient.js";
import type { ClaudeTurnResultFrame, HostOp, HostOpResult } from "../../shared/host-op.js";
import {
	ClaudeTurnResultFrameSchema,
	HostClaudeCancelResultSchema,
	HostClaudeRunReplySchema,
} from "../../shared/host-op.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { CodexAgentCommands } from "../codexAgentCommands.js";
import { fireAndForget } from "../fireAndForget.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import { answerOutcome, failureOutcome } from "./agentViews.js";
import type { PendingCall } from "./dispatchCore.js";
import {
	type HostFailure,
	hostFailure,
	issueSettled,
	latestThreadMap,
	latestTurn,
	makeTurn,
	parseTarget,
	taskIssueKey,
	threadMapRow,
	thrownHostFailure,
} from "./dispatchCore.js";
import type { WorkflowDispatchOutcome, WorkflowIssuedCall } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import type { WorkflowJournalRow } from "./workflowSchemas.js";

interface ClaudeStepDeps {
	runner: WorkflowRunner;
	ambient: Pick<Ambient, "newId">;
	readLiveness: HostLivenessReader;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	codex: Pick<CodexAgentCommands, "resolveTarget">;
}

interface ClaudeStepsContext {
	deps: ClaudeStepDeps;
	pending: () => Map<string, PendingCall>;
	isStopped: () => boolean;
	settle: (task: PendingCall, outcome: WorkflowDispatchOutcome) => void;
	attempt: (task: PendingCall) => Promise<void>;
	composePrompt: (task: PendingCall, target: AgentExecutionTarget, fresh: boolean) => Promise<string | null>;
	projectInstructions: (
		task: PendingCall,
		target: AgentExecutionTarget,
		replayed: boolean,
	) => Promise<{ text: string | null } | null>;
}

/** Owns Claude turn lifecycle. */
export function createClaudeSteps(ctx: ClaudeStepsContext) {
	const { deps, pending, isStopped, settle, attempt, composePrompt, projectInstructions } = ctx;
	const claudeWaiters = new Map<string, Set<{ resolve: () => void; reject: (error: Error) => void }>>();
	const claudeFrames = new Map<string, ClaudeTurnResultFrame>();
	const processingClaudeTurns = new Set<string>();
	const cancelOwed = new Set<string>();
	/** Cancel answers by instance. */
	const cancelAnswered = new Map<string, string>();
	const cancelInFlight = new Set<string>();

	function claudeWaiterKey(call: WorkflowIssuedCall): string {
		return taskIssueKey(call.runId, call.issueOrdinal);
	}
	function claudeTurnKey(runId: string, turnId: string): string {
		return `${runId}:${turnId}`;
	}
	function claudeResume(task: PendingCall, turn: Extract<WorkflowJournalRow, { kind: "turn" }>): boolean {
		const earlier = deps.runner
			.rows(task.issued.runId)
			.filter(
				(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
					row.kind === "turn" &&
					row.backend === "claude" &&
					row.issueOrdinal === task.issued.issueOrdinal &&
					row.turnOrdinal < turn.turnOrdinal,
			);
		if (earlier.some((row) => row.agentId === turn.agentId)) return true;
		return turn.turnOrdinal === 1 && task.issued.threadAgent !== undefined;
	}
	function settleClaude(
		task: PendingCall,
		target: AgentExecutionTarget,
		agentId: string,
		outcome: WorkflowDispatchOutcome,
	): void {
		const mapping = threadMapRow(task, agentId, target);
		settle(task, { ...outcome, ...(mapping ? { threadMap: mapping } : {}) });
	}
	function applyFailure(task: PendingCall, failure: HostFailure): void {
		if ("waitFor" in failure) task.waitFor = failure.waitFor;
		else settle(task, failure.outcome);
	}
	async function postClaudeRun(
		task: PendingCall,
		turn: Extract<WorkflowJournalRow, { kind: "turn" }>,
		resume: boolean,
		appendSystemPrompt: string | null,
	): Promise<void> {
		const target = parseTarget(turn.target);
		if (!target || !turn.agentId) {
			settle(task, { outcome: "failed", answer: null, reason: "journaled Claude turn is invalid" });
			return;
		}
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) {
			task.waitFor = "catalog";
			return;
		}
		if (turn.registerInstanceId !== live.daemonInstanceId) {
			task.waitFor = "catalog";
			return;
		}
		if (target.kind === "devcontainer" && !live.containerInCatalog(target)) {
			task.waitFor = "catalog";
			return;
		}
		let result: HostOpResult;
		try {
			result = await deps.relayToHost({
				kind: "claudeRun",
				target,
				runId: task.issued.runId,
				turnId: turn.turnId,
				sessionId: turn.agentId,
				resume,
				prompt: turn.prompt,
				appendSystemPrompt,
				...(task.issued.options.model === undefined ? {} : { model: task.issued.options.model }),
				...(task.issued.options.effort === undefined ? {} : { effort: task.issued.options.effort }),
				...(task.issued.options.schema === undefined ? {} : { jsonSchema: task.issued.options.schema }),
			});
		} catch (error) {
			applyFailure(task, thrownHostFailure(error));
			return;
		}
		if (isStopped() || task.done) return;
		if (!result.ok) {
			applyFailure(task, hostFailure("claude run", result.error, result.errorKind));
			return;
		}
		const checked = HostClaudeRunReplySchema.safeParse(result.result);
		if (!checked.success) {
			settleClaude(task, target, turn.agentId, {
				outcome: "failed",
				answer: null,
				reason: "claude run returned an invalid reply",
			});
			return;
		}
		if (checked.data.kind === "refused") {
			if (checked.data.code === "busy") {
				task.waitFor = "tick";
				return;
			}
			const outcome: WorkflowDispatchOutcome =
				checked.data.code === "binaryMissing"
					? { outcome: "unavailable", answer: null, reason: "claude is not installed on the host" }
					: { outcome: "failed", answer: null, reason: "claude target is invalid" };
			settleClaude(task, target, turn.agentId, outcome);
			return;
		}
		task.waitFor = "agent";
	}
	async function attemptClaude(task: PendingCall, owner: SessionRecord): Promise<void> {
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) {
			task.waitFor = "catalog";
			return;
		}
		const previous = latestTurn(task, deps.runner);
		const mapping = latestThreadMap(task, deps.runner) ?? task.issued.threadAgent;
		const switched = Boolean(
			previous &&
				mapping &&
				mapping.lastIssueOrdinal === task.issued.issueOrdinal &&
				mapping.agentId !== previous.agentId,
		);
		const correctionTurn = task.issued.correction !== undefined;
		if (previous && !correctionTurn && !switched) {
			if (previous.registerInstanceId !== live.daemonInstanceId) {
				settle(task, {
					outcome: "interrupted",
					answer: null,
					reason: "runner lost: the host daemon restarted",
				});
				return;
			}
			if (task.waitFor !== "tick" && task.waitFor !== "catalog") {
				task.waitFor = "agent";
				return;
			}
			const target = parseTarget(previous.target);
			if (!target || !previous.agentId) {
				settle(task, { outcome: "failed", answer: null, reason: "journaled Claude turn is invalid" });
				return;
			}
			const project = await projectInstructions(task, target, true);
			if (!project || task.done) return;
			await postClaudeRun(task, previous, claudeResume(task, previous), project.text);
			return;
		}

		let target: AgentExecutionTarget | undefined = previous
			? parseTarget(previous.target)
			: mapping
				? parseTarget(mapping.target)
				: undefined;
		if (!target) target = deps.codex.resolveTarget(owner) ?? undefined;
		if (!target) {
			settle(task, { outcome: "rejected", answer: null, reason: "session has no agent execution target" });
			return;
		}
		if (target.kind === "devcontainer" && !live.containerInCatalog(target)) {
			task.waitFor = "catalog";
			return;
		}
		const project = await projectInstructions(task, target, Boolean(previous || mapping));
		if (!project || task.done) return;
		const sessionId = switched ? mapping!.agentId : (previous?.agentId ?? mapping?.agentId ?? deps.ambient.newId());
		const resume = switched ? false : correctionTurn || mapping !== undefined;
		const fresh = !resume;
		const prompt =
			previous && !switched && correctionTurn
				? await composePrompt(task, target, false)
				: previous && !switched && !correctionTurn
					? previous.prompt
					: await composePrompt(task, target, fresh);
		if (prompt === null || task.done) return;
		if (typeof prompt !== "string") return;
		const currentLive = deps.readLiveness();
		if (!currentLive.socket || !currentLive.daemonInstanceId) {
			task.waitFor = "catalog";
			return;
		}
		if (target.kind === "devcontainer" && !currentLive.containerInCatalog(target)) {
			task.waitFor = "catalog";
			return;
		}
		const turn = makeTurn(task, null, sessionId, currentLive.daemonInstanceId, target, prompt, deps.runner, () =>
			deps.ambient.newId(),
		);
		if (!deps.runner.append(task.issued.runId, turn)) {
			settle(task, { outcome: "failed", answer: null, reason: "workflow turn could not be journaled" });
			return;
		}
		task.prompt = prompt;
		await postClaudeRun(task, turn, resume, project.text);
	}
	async function processClaudeResult(
		task: PendingCall,
		turn: Extract<WorkflowJournalRow, { kind: "turn" }>,
		frame: ClaudeTurnResultFrame,
	): Promise<void> {
		const turnKey = claudeTurnKey(frame.runId, frame.turnId);
		if (processingClaudeTurns.has(turnKey) || task.done || isStopped()) return;
		const current = latestTurn(task, deps.runner);
		if (current?.turnId !== turn.turnId || turn.agentId !== frame.sessionId) return;
		processingClaudeTurns.add(turnKey);
		const target = parseTarget(turn.target);
		if (!target || !turn.agentId) {
			settle(task, { outcome: "failed", answer: null, reason: "journaled Claude turn is invalid" });
			processingClaudeTurns.delete(turnKey);
			return;
		}
		try {
			if (frame.outcome === "sessionMissing") {
				const agentIds = new Set(
					deps.runner
						.rows(task.issued.runId)
						.filter(
							(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
								row.kind === "turn" &&
								row.backend === "claude" &&
								row.issueOrdinal === task.issued.issueOrdinal,
						)
						.map((row) => row.agentId)
						.filter((agentId): agentId is string => agentId !== null),
				);
				if (task.issued.options.thread && agentIds.size === 1) {
					const agentId = deps.ambient.newId();
					const mapping = threadMapRow(task, agentId, target);
					if (!mapping || !deps.runner.append(task.issued.runId, mapping)) {
						settle(task, {
							outcome: "failed",
							answer: null,
							reason: "Claude thread switch could not be journaled",
						});
						return;
					}
					task.waitFor = null;
					fireAndForget("workflow Claude thread switch", attempt(task));
					return;
				}
				settleClaude(task, target, turn.agentId, {
					outcome: "failed",
					answer: null,
					reason: frame.reason ?? "No conversation found",
				});
				return;
			}
			if (frame.outcome === "completed") {
				settleClaude(
					task,
					target,
					turn.agentId,
					answerOutcome(frame.answer, task.issued.options.schema !== undefined),
				);
				return;
			}
			if (frame.outcome === "cancelled") {
				settleClaude(task, target, turn.agentId, {
					outcome: "interrupted",
					answer: null,
					reason: "cancelled",
				});
				return;
			}
			settleClaude(
				task,
				target,
				turn.agentId,
				frame.reason === "binaryMissing"
					? { outcome: "unavailable", answer: null, reason: "claude is not installed where the step runs" }
					: failureOutcome(frame.reason ?? "claude step failed"),
			);
		} finally {
			processingClaudeTurns.delete(turnKey);
		}
	}
	function resolveClaudeWaiters(call: WorkflowIssuedCall): void {
		const key = claudeWaiterKey(call);
		for (const waiter of claudeWaiters.get(key) ?? []) waiter.resolve();
		claudeWaiters.delete(key);
		for (const [turnKey, frame] of claudeFrames) {
			const turn = deps.runner
				.rows(frame.runId)
				.find((row) => row.kind === "turn" && row.turnId === frame.turnId);
			if (turn?.kind === "turn" && frame.runId === call.runId && turn.issueOrdinal === call.issueOrdinal) {
				claudeFrames.delete(turnKey);
			}
		}
	}

	function releaseClaudeRun(runId: string): void {
		const prefix = `${runId}:`;
		for (const [key, waiters] of claudeWaiters) {
			if (!key.startsWith(prefix)) continue;
			for (const waiter of waiters) waiter.resolve();
			claudeWaiters.delete(key);
		}
		for (const [key, frame] of claudeFrames) if (frame.runId === runId) claudeFrames.delete(key);
	}
	function rejectClaudeWaiters(error: Error): void {
		for (const waiters of claudeWaiters.values()) for (const waiter of waiters) waiter.reject(error);
		claudeWaiters.clear();
		claudeFrames.clear();
	}
	function applyQueuedClaudeResult(task: PendingCall): void {
		const turn = latestTurn(task, deps.runner);
		if (turn?.backend !== "claude") return;
		const key = claudeTurnKey(task.issued.runId, turn.turnId);
		const frame = claudeFrames.get(key);
		if (frame) fireAndForget("workflow Claude result", processClaudeResult(task, turn, frame));
	}
	function claudeTurnResult(frame: ClaudeTurnResultFrame): Promise<void> {
		const parsed = ClaudeTurnResultFrameSchema.safeParse(frame);
		if (!parsed.success) return Promise.reject(new Error("invalid Claude turn result"));
		const turn = deps.runner
			.rows(frame.runId)
			.find(
				(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
					row.kind === "turn" && row.backend === "claude" && row.turnId === frame.turnId,
			);
		// Prevent outbox replay.
		if (!turn || turn.agentId !== frame.sessionId) {
			console.warn(`[workflow] dropped a claude result for an unknown turn of ${frame.runId}`);
			return Promise.resolve();
		}
		if (issueSettled(frame.runId, turn.issueOrdinal, deps.runner)) return Promise.resolve();
		if (deps.runner.get(frame.runId)?.status !== "running") return Promise.resolve();
		const key = taskIssueKey(frame.runId, turn.issueOrdinal);
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const waiters = claudeWaiters.get(key) ?? new Set();
		waiters.add({ resolve, reject });
		claudeWaiters.set(key, waiters);
		const turnKey = claudeTurnKey(frame.runId, frame.turnId);
		if (!claudeFrames.has(turnKey)) claudeFrames.set(turnKey, frame);
		const task = pending().get(key);
		if (task) fireAndForget("workflow Claude result", processClaudeResult(task, turn, frame));
		return completion;
	}
	function strandedClaudeTurns(
		runId: string,
		instance: string | undefined,
	): Array<Extract<WorkflowJournalRow, { kind: "turn" }>> {
		const terminal = deps.runner.get(runId)?.status !== "running";
		const latest = new Map<number, Extract<WorkflowJournalRow, { kind: "turn" }>>();
		const settled = new Map<number, string>();
		for (const row of deps.runner.rows(runId)) {
			if (row.kind === "settle") settled.set(row.issueOrdinal, row.outcome);
			if (row.kind !== "turn" || row.backend !== "claude") continue;
			const current = latest.get(row.issueOrdinal);
			if (!current || row.turnOrdinal > current.turnOrdinal) latest.set(row.issueOrdinal, row);
		}
		return [...latest.values()].filter((turn) => {
			const outcome = settled.get(turn.issueOrdinal);
			if (outcome !== undefined && outcome !== "interrupted") return false;
			return terminal || turn.registerInstanceId !== instance;
		});
	}

	function cancelStrandedClaudeTurns(runId: string): void {
		const live = deps.readLiveness();
		const instance = live.daemonInstanceId;
		let owed = false;
		for (const turn of strandedClaudeTurns(runId, instance)) {
			const key = claudeTurnKey(runId, turn.turnId);
			if (instance && cancelAnswered.get(key) === instance) continue;
			const target = parseTarget(turn.target);
			if (!target) continue;
			owed = true;
			if (!live.socket || !instance || cancelInFlight.has(key)) continue;
			cancelInFlight.add(key);
			const op = { kind: "claudeCancel" as const, runId, turnId: turn.turnId, target };
			void Promise.resolve()
				.then(() => deps.relayToHost(op))
				.then((result) => {
					if (result.ok && HostClaudeCancelResultSchema.safeParse(result.result).data?.cancelled) {
						cancelAnswered.set(key, instance);
					}
				})
				.catch(() => {})
				.finally(() => cancelInFlight.delete(key));
		}
		if (owed) cancelOwed.add(runId);
		else cancelOwed.delete(runId);
	}
	function retryOwedCancels(): void {
		const held = new Set(deps.runner.runs().map((record) => record.runId));
		for (const key of cancelAnswered.keys()) {
			if (!held.has(key.slice(0, key.indexOf(":")))) cancelAnswered.delete(key);
		}
		for (const runId of [...cancelOwed]) {
			if (held.has(runId)) cancelStrandedClaudeTurns(runId);
			else cancelOwed.delete(runId);
		}
	}
	function hostRegistered(liveInstanceId: string | undefined): void {
		for (const task of pending().values()) {
			if (task.done || task.issued.backend !== "claude") continue;
			const turn = latestTurn(task, deps.runner);
			if (!turn || turn.registerInstanceId === liveInstanceId) continue;
			settle(task, {
				outcome: "interrupted",
				answer: null,
				reason: "runner lost: the host daemon restarted",
			});
		}
		for (const record of deps.runner.runs()) cancelStrandedClaudeTurns(record.runId);
	}
	return {
		attemptClaude,
		applyQueuedClaudeResult,
		claudeTurnResult,
		resolveClaudeWaiters,
		releaseClaudeRun,
		rejectClaudeWaiters,
		cancelStrandedClaudeTurns,
		retryOwedCancels,
		hostRegistered,
	};
}
