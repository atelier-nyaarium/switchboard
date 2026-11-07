import crypto from "node:crypto";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { AGENT_PROMPT_MAX_BYTES, AGENT_TURN_LOST_REASON } from "../../shared/agent-record.js";
import type { Ambient } from "../../shared/ambient.js";
import { type CodexPersistedAgent, codexAgentIdForOperation } from "../../shared/codex-agent.js";
import { type CopilotPersistedAgent, copilotAgentIdForOperation } from "../../shared/copilot-agent.js";
import {
	type ClaudeTurnResultFrame,
	ClaudeTurnResultFrameSchema,
	HostClaudeRunReplySchema,
	type HostOp,
	type HostOpResult,
	HostReadSkillResultSchema,
} from "../../shared/host-op.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import type { CodexAgentCommands, CodexDispatchResult } from "../codexAgentCommands.js";
import type { CodexRelay } from "../codexRelay.js";
import type { CopilotAgentCommands, CopilotDispatchResult } from "../copilotAgentCommands.js";
import type { CopilotRelay } from "../copilotRelay.js";
import { fireAndForget } from "../fireAndForget.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import type { WorkflowDispatchOutcome, WorkflowDispatchPort, WorkflowIssuedCall } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import { type JsonValue, JsonValueSchema, type WorkflowJournalRow } from "./workflowSchemas.js";

const SKILL_MARKER_START = "--- BEGIN WORKFLOW SKILL: ";
const SKILL_MARKER_END = "--- END WORKFLOW SKILL: ";
const DECLINE_TEXT =
	/content[_ -]?filter|safety classifier|terms of service|policy violation|i (?:cannot|can't|won't) (?:help|assist|provide)|i must decline/i;
const REJECT_TEXT =
	/unsupported (?:model|effort|reasoning|schema)|unknown (?:model|effort)|invalid (?:model|effort)|schema.{0,40}(?:unsupported|not supported|cannot use)|skill.{0,40}(?:not found|missing)/i;

interface AgentOperation {
	operationId: string;
	kind: "start" | "message" | "stop";
	state: "requested" | "accepted" | "indeterminate";
	daemonInstanceId?: string;
	turnId?: string;
	refusal?: { code?: string; message: string };
}

interface AgentView {
	agentId: string;
	runId?: string;
	state: string;
	activeTurnId?: string;
	target: AgentExecutionTarget;
	operations: AgentOperation[];
	turns: Array<{ id: string; state: string; finalResponse?: string; error?: string; reason?: string }>;
}

interface PendingCall {
	issued: WorkflowIssuedCall;
	settle: (outcome: WorkflowDispatchOutcome) => void;
	done: boolean;
	running: boolean;
	changedBy: string | null;
	waitFor: "agent" | "catalog" | "tick" | null;
	unsubscribe?: () => void;
	lastOperationId?: string;
	lastAgentId?: string;
	lastSocket?: object;
	prompt?: string;
}

export interface WorkflowAgentDispatchDeps {
	sessionStore: Pick<SessionStore, "getByTeam" | "list" | "teamOf">;
	ambient: Pick<Ambient, "now" | "newId">;
	runner: WorkflowRunner;
	readLiveness: HostLivenessReader;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	codex: CodexAgentCommands;
	copilot: CopilotAgentCommands;
	codexRelay: CodexRelay;
	copilotRelay: CopilotRelay;
}

function taskKey(call: WorkflowIssuedCall): string {
	return taskIssueKey(call.runId, call.issueOrdinal);
}

function taskIssueKey(runId: string, issueOrdinal: number): string {
	return `${runId}:${issueOrdinal}`;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function responseValue(text: string): JsonValue {
	try {
		return JsonValueSchema.parse(JSON.parse(text));
	} catch {
		return text;
	}
}

function refusalOutcome(reason: string, code?: string): Exclude<WorkflowDispatchOutcome["outcome"], "completed"> {
	if (code === "daemon_unavailable" || code === "app_server_unavailable" || code === "protocol_incompatible") {
		return "unavailable";
	}
	if (DECLINE_TEXT.test(reason)) return "declined";
	if (REJECT_TEXT.test(reason)) return "rejected";
	return "failed";
}

function familyTextError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function normalizeCodex(
	agent: CodexPersistedAgent | undefined,
	refusalReason?: string,
	refusalOperationId?: string,
): AgentView | undefined {
	if (!agent) return undefined;
	return {
		agentId: agent.agentId,
		...(agent.runId ? { runId: agent.runId } : {}),
		state: agent.agentState,
		...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
		target: agent.requestedTarget,
		operations: agent.operations.map((operation) => ({
			operationId: operation.operationId,
			kind: operation.kind,
			state: operation.state,
			...(operation.daemonInstanceId ? { daemonInstanceId: operation.daemonInstanceId } : {}),
			...(operation.turnId ? { turnId: operation.turnId } : {}),
			...(refusalReason && operation.operationId === refusalOperationId
				? { refusal: { message: refusalReason } }
				: {}),
		})),
		turns: agent.turns.map((turn) => ({
			id: turn.id,
			state: turn.state,
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
			...(turn.state === "failed" ? { error: turn.error } : {}),
			...(turn.state === "interrupted" && turn.reason ? { reason: turn.reason } : {}),
		})),
	};
}

function normalizeCopilot(
	agent: CopilotPersistedAgent | undefined,
	refusal?: { code?: string; message: string },
	refusalOperationId?: string,
): AgentView | undefined {
	if (!agent) return undefined;
	return {
		agentId: agent.agentId,
		...(agent.runId ? { runId: agent.runId } : {}),
		state: agent.agentState,
		...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
		target: agent.requestedTarget,
		operations: agent.operations.map((operation) => ({
			operationId: operation.operationId,
			kind: operation.kind,
			state: operation.state,
			...(operation.daemonInstanceId ? { daemonInstanceId: operation.daemonInstanceId } : {}),
			...(operation.turnId ? { turnId: operation.turnId } : {}),
			...(refusal && operation.operationId === refusalOperationId ? { refusal } : {}),
		})),
		turns: agent.turns.map((turn) => ({
			id: turn.id,
			state: turn.state,
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
			...(turn.state === "failed" ? { error: turn.error } : {}),
			...(turn.state === "interrupted" && turn.reason ? { reason: turn.reason } : {}),
		})),
	};
}

export interface WorkflowAgentDispatch {
	port: WorkflowDispatchPort;
	claudeTurnResult(frame: ClaudeTurnResultFrame): Promise<void>;
	retireRun(run: { runId: string; team: string }): boolean;
	inspectThread(input: { team: string; agentId: string }): { state: string; runId?: string } | null;
	retagThread(input: { team: string; agentId: string; fromRunId: string; toRunId: string }): boolean;
}

export function createWorkflowAgentDispatch(deps: WorkflowAgentDispatchDeps): WorkflowAgentDispatch {
	const pending = new Map<string, PendingCall>();
	const claudeWaiters = new Map<string, Set<{ resolve: () => void; reject: (error: Error) => void }>>();
	const claudeFrames = new Map<string, ClaudeTurnResultFrame>();
	const processingClaudeTurns = new Set<string>();
	/** Terminal runs that may still have a claude turn running. */
	const cancelOwed = new Set<string>();
	/** Turn key to the daemon instance that answered its cancel. */
	const cancelAnswered = new Map<string, string>();
	const cancelInFlight = new Set<string>();
	const stopSent = new WeakMap<object, Set<string>>();
	const idleListeners = new Map<string, () => void>();
	let stopped = false;
	let registering = false;

	const ownerOf = (team: string): SessionRecord | undefined => deps.sessionStore.getByTeam(team);

	function snapshot(
		owner: SessionRecord,
		backend: "codex" | "copilot",
		agentId: string,
		operationId?: string,
	): AgentView | undefined {
		if (backend === "codex") {
			const result = deps.codex.observe(owner, agentId, operationId);
			return normalizeCodex(result.agent, result.refusalReason, operationId);
		}
		const result = deps.copilot.observe(owner, agentId, operationId);
		return normalizeCopilot(result.agent, result.refusal, operationId);
	}

	function listRunAgents(owner: SessionRecord, runId: string): AgentView[] {
		return [
			...deps.codex
				.list(owner)
				.filter((agent) => agent.runId === runId)
				.flatMap((agent) => {
					const view = normalizeCodex(agent);
					return view ? [view] : [];
				}),
			...deps.copilot
				.list(owner)
				.filter((agent) => agent.runId === runId)
				.flatMap((agent) => {
					const view = normalizeCopilot(agent);
					return view ? [view] : [];
				}),
		];
	}

	function listAgent(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): AgentView | undefined {
		if (backend === "codex")
			return normalizeCodex(deps.codex.list(owner).find((agent) => agent.agentId === agentId));
		return normalizeCopilot(deps.copilot.list(owner).find((agent) => agent.agentId === agentId));
	}

	function retire(owner: SessionRecord, backend: "codex" | "copilot", agentId: string): boolean {
		const result = backend === "codex" ? deps.codex.retire(owner, agentId) : deps.copilot.retire(owner, agentId);
		return result.retired;
	}

	function abandon(owner: SessionRecord, backend: "codex" | "copilot", agentId: string, operationId: string): void {
		if (backend === "codex") deps.codex.abandon(owner, agentId, operationId, deps.ambient.now());
		else deps.copilot.abandon(owner, agentId, operationId, deps.ambient.now());
	}

	function settle(task: PendingCall, outcome: WorkflowDispatchOutcome): void {
		if (task.done || stopped) return;
		task.done = true;
		task.unsubscribe?.();
		task.unsubscribe = undefined;
		pending.delete(taskKey(task.issued));
		task.settle(outcome);
	}

	function threadMap(
		task: PendingCall,
		agent: AgentView,
	): Extract<WorkflowJournalRow, { kind: "thread_map" }> | undefined {
		const key = task.issued.options.thread;
		if (!key) return undefined;
		return {
			kind: "thread_map",
			thread: key,
			backend: task.issued.backend,
			agentId: agent.agentId,
			target: JSON.stringify(agent.target),
			lastIssueOrdinal: task.issued.issueOrdinal,
		};
	}

	function finishFromTurn(task: PendingCall, agent: AgentView, operation: AgentOperation): boolean {
		if (operation.state === "requested") return false;
		if (operation.state === "indeterminate") {
			const live = deps.readLiveness().daemonInstanceId;
			if (operation.daemonInstanceId && operation.daemonInstanceId !== live) return false;
			const reason = operation.refusal?.message ?? "daemon refused the workflow step";
			const outcome = refusalOutcome(reason, operation.refusal?.code);
			settle(task, { outcome, answer: null, reason });
			return true;
		}
		const turnId = operation.turnId ?? agent.activeTurnId;
		if (!turnId) return false;
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (!turn || turn.state === "inProgress") return false;
		const mapping = threadMap(task, agent);
		if (turn.state === "completed") {
			const answer = turn.finalResponse ?? "";
			if (DECLINE_TEXT.test(answer)) {
				settle(task, {
					outcome: "declined",
					answer: null,
					reason: answer,
					...(mapping ? { threadMap: mapping } : {}),
				});
				return true;
			}
			settle(task, {
				outcome: "completed",
				answer: responseValue(answer),
				reason: null,
				...(mapping ? { threadMap: mapping } : {}),
			});
			return true;
		}
		if (turn.state === "interrupted") {
			const reason = turn.reason ?? "agent turn interrupted";
			settle(task, {
				outcome: reason === AGENT_TURN_LOST_REASON ? "lost" : "interrupted",
				answer: null,
				reason,
				...(mapping ? { threadMap: mapping } : {}),
			});
			return true;
		}
		const reason = turn.error ?? "agent turn failed";
		const outcome = refusalOutcome(reason);
		settle(task, { outcome, answer: null, reason, ...(mapping ? { threadMap: mapping } : {}) });
		return true;
	}

	function detach(task: PendingCall): void {
		task.unsubscribe?.();
		task.unsubscribe = undefined;
	}

	function watch(task: PendingCall, owner: SessionRecord, agentId: string): void {
		if (task.changedBy === agentId) return;
		detach(task);
		task.changedBy = agentId;
		const ownerKey = deps.sessionStore.teamOf(owner);
		const relay = task.issued.backend === "codex" ? deps.codexRelay : deps.copilotRelay;
		task.unsubscribe = relay.onAgentChange(ownerKey, agentId, () => {
			if (stopped || task.done) return;
			fireAndForget("workflow agent change", poll(task));
		});
	}

	function latestTurn(task: PendingCall): Extract<WorkflowJournalRow, { kind: "turn" }> | undefined {
		return deps.runner
			.rows(task.issued.runId)
			.filter(
				(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
					row.kind === "turn" && row.issueOrdinal === task.issued.issueOrdinal,
			)
			.sort((left, right) => right.turnOrdinal - left.turnOrdinal)[0];
	}

	function currentPrompt(task: PendingCall): string {
		if (task.prompt !== undefined) return task.prompt;
		const correction = task.issued.correction;
		if (!correction) return task.issued.prompt;
		return `${task.issued.prompt}\n\nCorrect the previous answer for the supplied schema.\nPrevious answer: ${JSON.stringify(correction.answer)}\nSchema errors:\n${correction.errors.join("\n")}`;
	}

	function skillRows(runId: string): Map<string, string> {
		const byHash = new Map<string, string>();
		const byPath = new Map<string, string>();
		for (const row of deps.runner.rows(runId)) {
			if (row.kind !== "skill_text") continue;
			if (row.text !== undefined) byHash.set(row.sha256, row.text);
			byPath.set(row.path, row.sha256);
		}
		return new Map(
			[...byPath].flatMap(([path, hash]) => {
				const text = byHash.get(hash);
				return text === undefined ? [] : [[path, text] as const];
			}),
		);
	}

	async function composePrompt(
		task: PendingCall,
		target: AgentExecutionTarget,
		fresh: boolean,
	): Promise<string | null> {
		const paths = fresh ? (task.issued.options.skills ?? []) : [];
		if (paths.length === 0) return currentPrompt(task);
		const textByPath = skillRows(task.issued.runId);
		const skills: Array<{ path: string; text: string }> = [];
		for (const skillPath of paths) {
			let text = textByPath.get(skillPath);
			if (text === undefined) {
				const result = await deps.relayToHost({ kind: "readSkill", target, path: skillPath });
				if (stopped || task.done) return null;
				if (!result.ok) {
					if (result.errorKind === "timeout" || /did not take|not taken/i.test(result.error ?? "")) {
						task.waitFor = "tick";
					} else {
						task.waitFor = "catalog";
					}
					return null;
				}
				const checked = HostReadSkillResultSchema.safeParse(result.result);
				if (!checked.success) {
					settle(task, { outcome: "failed", answer: null, reason: `skill ${skillPath}: invalid host reply` });
					return null;
				}
				const read = checked.data;
				if (read?.kind === "refused") {
					const reason = `skill ${skillPath}: ${read.code}`;
					settle(task, { outcome: "rejected", answer: null, reason });
					return null;
				}
				text = read.text;
				const sha256 = crypto.createHash("sha256").update(text, "utf8").digest("hex");
				const existingHash = new Set(
					deps.runner
						.rows(task.issued.runId)
						.filter(
							(row): row is Extract<WorkflowJournalRow, { kind: "skill_text" }> =>
								row.kind === "skill_text",
						)
						.map((row) => row.sha256),
				);
				deps.runner.append(task.issued.runId, {
					kind: "skill_text",
					path: skillPath,
					sha256,
					...(existingHash.has(sha256) ? {} : { text }),
				});
			}
			skills.push({ path: skillPath, text });
		}
		const body = skills
			.map(({ path, text }) => `${SKILL_MARKER_START}${path} ---\n${text}\n${SKILL_MARKER_END}${path} ---`)
			.join("\n\n");
		const composed = `${body}\n\n${currentPrompt(task)}`;
		if (byteLength(composed) > AGENT_PROMPT_MAX_BYTES) {
			settle(task, { outcome: "failed", answer: null, reason: "prompt plus skills exceeds the limit" });
			return null;
		}
		return composed;
	}

	function appendSkillText(runId: string, path: string, text: string): boolean {
		const sha256 = crypto.createHash("sha256").update(text, "utf8").digest("hex");
		const rows = deps.runner.rows(runId);
		const alreadyStored = rows.some(
			(row) => row.kind === "skill_text" && row.sha256 === sha256 && row.text !== undefined,
		);
		return deps.runner.append(runId, {
			kind: "skill_text",
			path,
			sha256,
			...(alreadyStored ? {} : { text }),
		});
	}

	function claudeWaiterKey(call: WorkflowIssuedCall): string {
		return taskIssueKey(call.runId, call.issueOrdinal);
	}

	function claudeTurnKey(runId: string, turnId: string): string {
		return `${runId}:${turnId}`;
	}

	function issueSettled(runId: string, issueOrdinal: number): boolean {
		return deps.runner.rows(runId).some((row) => row.kind === "settle" && row.issueOrdinal === issueOrdinal);
	}

	function latestThreadMap(task: PendingCall): Extract<WorkflowJournalRow, { kind: "thread_map" }> | undefined {
		const thread = task.issued.options.thread;
		if (!thread) return undefined;
		return deps.runner
			.rows(task.issued.runId)
			.filter(
				(row): row is Extract<WorkflowJournalRow, { kind: "thread_map" }> =>
					row.kind === "thread_map" && row.thread === thread,
			)
			.at(-1);
	}

	function claudeThreadMap(
		task: PendingCall,
		agentId: string,
		target: AgentExecutionTarget,
	): Extract<WorkflowJournalRow, { kind: "thread_map" }> | undefined {
		const thread = task.issued.options.thread;
		if (!thread) return undefined;
		return {
			kind: "thread_map",
			thread,
			backend: "claude",
			agentId,
			target: JSON.stringify(target),
			lastIssueOrdinal: task.issued.issueOrdinal,
		};
	}

	async function projectInstructions(
		task: PendingCall,
		target: AgentExecutionTarget,
		replayed: boolean,
	): Promise<{ text: string | null } | null> {
		const stored = skillRows(task.issued.runId);
		if (stored.has("AGENTS.md")) return { text: stored.get("AGENTS.md")! };
		if (stored.has("CLAUDE.md")) return { text: stored.get("CLAUDE.md")! };
		if (replayed) {
			return { text: null };
		}

		for (const path of ["AGENTS.md", "CLAUDE.md"]) {
			let result: HostOpResult;
			try {
				result = await deps.relayToHost({ kind: "readSkill", target, path });
			} catch (error) {
				task.waitFor = /timeout|timed out|not taken|did not take/i.test(familyTextError(error))
					? "tick"
					: "catalog";
				return null;
			}
			if (stopped || task.done) return null;
			if (!result.ok) {
				task.waitFor =
					result.errorKind === "timeout" || /did not take|not taken/i.test(result.error ?? "")
						? "tick"
						: "catalog";
				return null;
			}
			const checked = HostReadSkillResultSchema.safeParse(result.result);
			if (!checked.success) {
				settle(task, { outcome: "failed", answer: null, reason: `project instructions: invalid host reply` });
				return null;
			}
			if (checked.data.kind === "refused") {
				if (checked.data.code === "missing") continue;
				settle(task, {
					outcome: "rejected",
					answer: null,
					reason: `project instructions ${path}: ${checked.data.code}`,
				});
				return null;
			}
			if (!appendSkillText(task.issued.runId, path, checked.data.text)) {
				settle(task, {
					outcome: "failed",
					answer: null,
					reason: `project instructions ${path} could not be journaled`,
				});
				return null;
			}
			return { text: checked.data.text };
		}
		return { text: null };
	}

	function sendCommand(
		task: PendingCall,
		owner: SessionRecord,
		backend: "codex" | "copilot",
		mode: "start" | "message",
		agentId: string,
		operationId: string,
		prompt: string,
	): { dispatched: boolean; agentId: string } {
		const outputSchema = task.issued.options.schema;
		let result: CodexDispatchResult | CopilotDispatchResult;
		if (backend === "codex") {
			result =
				mode === "start"
					? deps.codex.start(owner, {
							operationId,
							prompt,
							...(task.issued.options.model === undefined ? {} : { model: task.issued.options.model }),
							...(task.issued.options.tier === undefined
								? {}
								: { serviceTier: task.issued.options.tier as "priority" | "standard" }),
							...(outputSchema === undefined ? {} : { outputSchema }),
							runId: task.issued.runId,
						})
					: deps.codex.message(owner, {
							agentId,
							operationId,
							prompt,
							...(task.issued.options.tier === undefined
								? {}
								: { serviceTier: task.issued.options.tier as "priority" | "standard" }),
							...(outputSchema === undefined ? {} : { outputSchema }),
						});
		} else {
			result =
				mode === "start"
					? deps.copilot.start(owner, {
							operationId,
							prompt,
							...(task.issued.options.model === undefined ? {} : { model: task.issued.options.model }),
							...(task.issued.options.effort === undefined
								? {}
								: { reasoningEffort: task.issued.options.effort }),
							...(outputSchema === undefined ? {} : { outputSchema }),
							runId: task.issued.runId,
						})
					: deps.copilot.message(owner, {
							agentId,
							operationId,
							prompt,
							...(outputSchema === undefined ? {} : { outputSchema }),
						});
		}
		if (result.kind === "refused") {
			if (result.code === "daemon_unavailable") {
				task.waitFor = "catalog";
				return { dispatched: false, agentId };
			}
			settle(task, { outcome: "failed", answer: null, reason: result.reason });
			return { dispatched: false, agentId };
		}
		if (!result.dispatched) {
			abandon(owner, backend, agentId, operationId);
			settle(task, { outcome: "failed", answer: null, reason: "agent daemon did not take the workflow step" });
			return { dispatched: false, agentId };
		}
		return { dispatched: true, agentId: result.transition.agent.agentId };
	}

	function makeTurn(
		task: PendingCall,
		operationId: string | null,
		agentId: string,
		registerInstanceId: string,
		target: AgentExecutionTarget,
		prompt: string,
	): Extract<WorkflowJournalRow, { kind: "turn" }> {
		const rows = deps.runner.rows(task.issued.runId);
		const turnOrdinal =
			rows.filter((entry) => entry.kind === "turn" && entry.issueOrdinal === task.issued.issueOrdinal).length + 1;
		return {
			kind: "turn",
			issueOrdinal: task.issued.issueOrdinal,
			turnOrdinal,
			turnId: deps.ambient.newId(),
			backend: task.issued.backend,
			prompt,
			operationId,
			registerInstanceId,
			agentId,
			target: JSON.stringify(target),
		};
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
		const mapping = claudeThreadMap(task, agentId, target);
		settle(task, { ...outcome, ...(mapping ? { threadMap: mapping } : {}) });
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
			task.waitFor = /timeout|timed out|not taken|did not take/i.test(familyTextError(error))
				? "tick"
				: "catalog";
			return;
		}
		if (stopped || task.done) return;
		if (!result.ok) {
			task.waitFor =
				result.errorKind === "timeout" || /did not take|not taken/i.test(result.error ?? "")
					? "tick"
					: "catalog";
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
		const previous = latestTurn(task);
		const mapping = latestThreadMap(task) ?? task.issued.threadAgent;
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
		const turn = makeTurn(task, null, sessionId, currentLive.daemonInstanceId, target, prompt);
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
		if (processingClaudeTurns.has(turnKey) || task.done || stopped) return;
		const current = latestTurn(task);
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
					const mapping = claudeThreadMap(task, agentId, target);
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
				const answer = typeof frame.answer === "string" ? responseValue(frame.answer) : frame.answer;
				settleClaude(task, target, turn.agentId, { outcome: "completed", answer, reason: null });
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
			settleClaude(task, target, turn.agentId, {
				outcome: "failed",
				answer: null,
				reason: frame.reason ?? "claude step failed",
			});
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

	/** A terminal run's results are acked: nothing reads them. */
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
		const turn = latestTurn(task);
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
		// Acked and dropped: nothing will ever read it, and refusing makes the daemon hold it.
		if (!turn || turn.agentId !== frame.sessionId) {
			console.warn(`[workflow] dropped a claude result for an unknown turn of ${frame.runId}`);
			return Promise.resolve();
		}
		if (issueSettled(frame.runId, turn.issueOrdinal)) return Promise.resolve();
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
		const task = pending.get(key);
		if (task) fireAndForget("workflow Claude result", processClaudeResult(task, turn, frame));
		return completion;
	}

	async function attempt(task: PendingCall): Promise<void> {
		if (stopped || task.done || task.running) return;
		if (registering) {
			task.waitFor = "catalog";
			return;
		}
		task.running = true;
		let pollAfterAttempt = false;
		try {
			const owner = ownerOf(task.issued.team);
			if (!owner) {
				settle(task, { outcome: "failed", answer: null, reason: "workflow session is no longer available" });
				return;
			}
			const live = deps.readLiveness();
			if (!live.socket || !live.daemonInstanceId) {
				task.waitFor = "catalog";
				return;
			}
			if (task.issued.backend === "claude") {
				applyQueuedClaudeResult(task);
				if (!task.done) await attemptClaude(task, owner);
				return;
			}
			const previous = latestTurn(task);
			const correctionTurn = task.issued.correction !== undefined && previous !== undefined;
			if (!correctionTurn && previous?.operationId && previous.agentId) {
				const known = snapshot(owner, task.issued.backend, previous.agentId, previous.operationId);
				const operation = known?.operations.find((entry) => entry.operationId === previous.operationId);
				if (operation && finishFromTurn(task, known!, operation)) return;
				if (operation?.state === "requested" || operation?.state === "accepted") {
					watch(task, owner, previous.agentId);
					task.waitFor = null;
					return;
				}
				if (operation?.state === "indeterminate" && operation.daemonInstanceId === live.daemonInstanceId) {
					const reason = operation.refusal?.message ?? "daemon refused the workflow step";
					settle(task, { outcome: refusalOutcome(reason, operation.refusal?.code), answer: null, reason });
					return;
				}
				if (previous.registerInstanceId === live.daemonInstanceId && !operation) {
					const target = known?.target ?? parseTarget(previous.target);
					if (!target) {
						settle(task, { outcome: "failed", answer: null, reason: "journaled target is invalid" });
						return;
					}
					if (target.kind === "devcontainer" && !live.containerInCatalog(target)) {
						task.waitFor = "catalog";
						return;
					}
					if (known && known.state !== "idle" && known.state !== "unavailable") {
						watch(task, owner, previous.agentId);
						task.waitFor = null;
						return;
					}
					if (known?.state === "unavailable") {
						if (!task.issued.options.thread) {
							settle(task, {
								outcome: "failed",
								answer: null,
								reason: "workflow start agent is unavailable",
							});
							return;
						}
					}
					const retryMode = task.issued.options.thread || correctionTurn ? "message" : "start";
					const result = sendCommand(
						task,
						owner,
						task.issued.backend,
						retryMode,
						previous.agentId,
						previous.operationId,
						previous.prompt,
					);
					if (result.dispatched) {
						watch(task, owner, previous.agentId);
						task.waitFor = null;
						pollAfterAttempt = true;
					}
					return;
				}
			}
			const backend = task.issued.backend;
			const commands = backend === "codex" ? deps.codex : deps.copilot;
			const requestedAgentId = task.issued.options.thread ? task.issued.threadAgent?.agentId : undefined;
			const priorAgentId = previous?.agentId ?? requestedAgentId;
			const existing = priorAgentId ? snapshot(owner, backend, priorAgentId) : undefined;
			const canMessage = Boolean(
				existing &&
					(existing.state === "idle" || existing.state === "working") &&
					!existing.operations.some((entry) => entry.state === "requested") &&
					(task.issued.options.thread !== undefined || correctionTurn),
			);
			if (existing && task.issued.options.thread && existing.state !== "idle") {
				if (
					existing.state === "unavailable" ||
					existing.state === "recovering" ||
					existing.state === "creating"
				) {
					if (existing.state !== "unavailable") {
						watch(task, owner, existing.agentId);
						task.waitFor = "agent";
						return;
					}
				} else {
					watch(task, owner, existing.agentId);
					task.waitFor = "agent";
					return;
				}
			}
			if (existing && existing.state === "working" && correctionTurn) {
				watch(task, owner, existing.agentId);
				task.waitFor = "agent";
				return;
			}
			const mode: "start" | "message" = canMessage ? "message" : "start";
			const target = mode === "message" ? existing!.target : commands.resolveTarget(owner);
			if (!target) {
				settle(task, { outcome: "rejected", answer: null, reason: "session has no agent execution target" });
				return;
			}
			if (!live.socket || !live.daemonInstanceId) {
				task.waitFor = "catalog";
				return;
			}
			if (mode === "start" && target.kind === "devcontainer" && !live.containerInCatalog(target)) {
				task.waitFor = "catalog";
				return;
			}
			let prompt: string | undefined =
				previous?.registerInstanceId === live.daemonInstanceId ? previous.prompt : undefined;
			if (prompt === undefined) {
				const composed = await composePrompt(task, target, mode === "start");
				if (composed === null || task.done) return;
				prompt = composed;
			}
			if (typeof prompt !== "string") return;
			const previousAgent = previous?.agentId ? listAgent(owner, backend, previous.agentId) : undefined;
			const previousOperation = previousAgent?.operations.find(
				(entry) => entry.operationId === previous?.operationId,
			);
			const reuseOperation =
				!correctionTurn &&
				previous?.registerInstanceId === live.daemonInstanceId &&
				previous?.operationId !== null &&
				previous?.operationId !== undefined &&
				previousAgent?.state !== "unavailable" &&
				!previousOperation;
			const operationId = reuseOperation ? previous!.operationId! : deps.ambient.newId();
			const agentId =
				mode === "message"
					? existing!.agentId
					: reuseOperation && previous?.agentId
						? previous.agentId
						: backend === "codex"
							? codexAgentIdForOperation(operationId)
							: copilotAgentIdForOperation(operationId);
			const currentRow =
				reuseOperation &&
				previous?.registerInstanceId === live.daemonInstanceId &&
				previous.operationId === operationId
					? previous
					: undefined;
			const turn = currentRow ?? makeTurn(task, operationId, agentId, live.daemonInstanceId, target, prompt);
			if (!currentRow && !deps.runner.append(task.issued.runId, turn)) {
				settle(task, { outcome: "failed", answer: null, reason: "workflow turn could not be journaled" });
				return;
			}
			task.prompt = prompt;
			task.lastOperationId = operationId;
			task.lastAgentId = agentId;
			const outcome = sendCommand(task, owner, backend, mode, agentId, operationId, prompt);
			if (task.done) return;
			if (outcome.dispatched) {
				task.lastOperationId = operationId;
				task.lastAgentId = outcome.agentId;
				task.lastSocket = live.socket;
				watch(task, owner, outcome.agentId);
				task.waitFor = null;
				pollAfterAttempt = true;
			}
		} catch (error) {
			const owner = ownerOf(task.issued.team);
			if (task.issued.backend !== "claude" && owner && task.lastAgentId && task.lastOperationId) {
				try {
					abandon(owner, task.issued.backend, task.lastAgentId, task.lastOperationId);
				} catch {}
			}
			settle(task, { outcome: "failed", answer: null, reason: familyTextError(error) });
		} finally {
			task.running = false;
			if (!task.done && pollAfterAttempt) fireAndForget("workflow agent poll", poll(task));
		}
	}

	async function poll(task: PendingCall): Promise<void> {
		if (stopped || registering || task.done || task.running) return;
		if (task.issued.backend === "claude") {
			if (task.waitFor !== null) fireAndForget("workflow Claude retry", attempt(task));
			return;
		}
		const owner = ownerOf(task.issued.team);
		const turn = latestTurn(task);
		if (!owner || !turn?.agentId || !turn.operationId) return;
		const agent = snapshot(owner, task.issued.backend, turn.agentId, turn.operationId);
		const operation = agent?.operations.find((entry) => entry.operationId === turn.operationId);
		if (agent && operation && finishFromTurn(task, agent, operation)) return;
		if (operation?.state === "requested" || operation?.state === "accepted") return;
		fireAndForget("workflow dispatch", attempt(task));
	}

	function retryPending(mode: "register" | "catalog" | "tick"): void {
		if (stopped || registering) return;
		if (mode === "register") reconcileTerminalRuns();
		for (const task of pending.values()) {
			if (task.done) continue;
			if (mode === "tick" && task.waitFor === "catalog") continue;
			if (mode === "catalog" && task.waitFor === "tick") continue;
			if (mode !== "tick" || task.waitFor !== null) fireAndForget("workflow retry", attempt(task));
		}
	}

	function stopAgent(owner: SessionRecord, backend: "codex" | "copilot", agent: AgentView): boolean {
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) return false;
		let sentForSocket = stopSent.get(live.socket);
		if (!sentForSocket) {
			sentForSocket = new Set();
			stopSent.set(live.socket, sentForSocket);
		}
		if (sentForSocket.has(agent.agentId)) return true;
		if (agent.operations.some((operation) => operation.kind === "stop" && operation.state === "requested")) {
			sentForSocket.add(agent.agentId);
			return true;
		}
		const operationId = deps.ambient.newId();
		sentForSocket.add(agent.agentId);
		try {
			const result =
				backend === "codex"
					? deps.codex.stop(owner, { agentId: agent.agentId, operationId })
					: deps.copilot.stop(owner, { agentId: agent.agentId, operationId });
			if (result.kind === "committed") {
				return result.dispatched;
			}
		} catch {}
		return false;
	}

	function familyOfAgent(owner: SessionRecord, agentId: string): "codex" | "copilot" | undefined {
		if (deps.codex.list(owner).some((agent) => agent.agentId === agentId)) return "codex";
		if (deps.copilot.list(owner).some((agent) => agent.agentId === agentId)) return "copilot";
		return undefined;
	}

	function watchIdle(
		owner: SessionRecord,
		backend: "codex" | "copilot",
		agentId: string,
		afterIdle: (agent: AgentView | undefined) => void,
	): void {
		const ownerKey = deps.sessionStore.teamOf(owner);
		const key = `${ownerKey}:${backend}:${agentId}`;
		if (idleListeners.has(key)) return;
		const relay = backend === "codex" ? deps.codexRelay : deps.copilotRelay;
		const unsubscribe = relay.onAgentChange(ownerKey, agentId, () => {
			const agent = listAgent(owner, backend, agentId);
			if (agent && agent.state !== "idle" && agent.state !== "unavailable") {
				afterIdle(agent);
				return;
			}
			unsubscribe();
			idleListeners.delete(key);
			afterIdle(agent);
		});
		idleListeners.set(key, unsubscribe);
	}

	function ensureTerminalAgent(
		owner: SessionRecord,
		run: { runId: string; team: string },
		agent: AgentView,
	): boolean {
		const family = familyOfAgent(owner, agent.agentId);
		if (!family) return true;
		if (agent.state === "working" || agent.turns.some((turn) => turn.state === "inProgress")) {
			stopAgent(owner, family, agent);
			const current = listAgent(owner, family, agent.agentId);
			if (current && (current.state === "idle" || current.state === "unavailable")) {
				return retire(owner, family, agent.agentId);
			}
			watchIdle(owner, family, agent.agentId, (current) => {
				if (!current || current.state === "idle" || current.state === "unavailable") {
					retire(owner, family, agent.agentId);
					return;
				}
				if (current.state === "working") stopAgent(owner, family, current);
			});
			return false;
		}
		if (agent.state === "idle" || agent.state === "unavailable") return retire(owner, family, agent.agentId);
		watchIdle(owner, family, agent.agentId, (current) => {
			if (!current || current.state === "idle" || current.state === "unavailable")
				retire(owner, family, agent.agentId);
			else ensureTerminalAgent(owner, run, current);
		});
		return false;
	}

	/** The latest claude turn of each issue that may still run: no settle, or an interrupted one. */
	function cancellableClaudeTurns(runId: string): Array<Extract<WorkflowJournalRow, { kind: "turn" }>> {
		const rows = deps.runner.rows(runId);
		const latest = new Map<number, Extract<WorkflowJournalRow, { kind: "turn" }>>();
		const settled = new Map<number, string>();
		for (const row of rows) {
			if (row.kind === "settle") settled.set(row.issueOrdinal, row.outcome);
			if (row.kind !== "turn" || row.backend !== "claude") continue;
			const current = latest.get(row.issueOrdinal);
			if (!current || row.turnOrdinal > current.turnOrdinal) latest.set(row.issueOrdinal, row);
		}
		return [...latest.values()].filter((turn) => {
			const outcome = settled.get(turn.issueOrdinal);
			return outcome === undefined || outcome === "interrupted";
		});
	}

	/**
	 * Read from the journal, so a lost accept reply, a lost cancel or a Gateway restart is still
	 * covered. Each turn is asked once per daemon instance, until that instance answers.
	 */
	function cancelTerminalClaudeTurns(runId: string): void {
		const live = deps.readLiveness();
		const instance = live.daemonInstanceId;
		let owed = false;
		for (const turn of cancellableClaudeTurns(runId)) {
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
					if (result.ok) cancelAnswered.set(key, instance);
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
			if (deps.runner.get(runId)?.status === "running") cancelOwed.delete(runId);
			else cancelTerminalClaudeTurns(runId);
		}
	}

	function reconcileTerminalRuns(): void {
		if (stopped) return;
		for (const record of deps.runner.runs()) {
			if (record.status === "running") continue;
			cancelTerminalClaudeTurns(record.runId);
			const owner = ownerOf(record.team);
			if (!owner) continue;
			for (const agent of listRunAgents(owner, record.runId)) ensureTerminalAgent(owner, record, agent);
		}
		const restored = new Set(deps.runner.runs().map((record) => record.runId));
		for (const owner of deps.sessionStore.list()) {
			const orphans = [
				...deps.codex
					.list(owner)
					.filter((agent) => agent.runId && !restored.has(agent.runId))
					.map((agent) => ["codex", agent.agentId] as const),
				...deps.copilot
					.list(owner)
					.filter((agent) => agent.runId && !restored.has(agent.runId))
					.map((agent) => ["copilot", agent.agentId] as const),
			];
			for (const [backend, agentId] of orphans) {
				const agent = listAgent(owner, backend, agentId);
				if (agent)
					ensureTerminalAgent(
						owner,
						{ runId: agent.runId ?? "", team: deps.sessionStore.teamOf(owner) },
						agent,
					);
			}
		}
	}

	function terminal(record: { runId: string; team: string }): void {
		for (const task of pending.values()) {
			if (task.issued.runId !== record.runId) continue;
			task.done = true;
			detach(task);
			pending.delete(taskKey(task.issued));
		}
		releaseClaudeRun(record.runId);
		cancelTerminalClaudeTurns(record.runId);
		const owner = ownerOf(record.team);
		if (!owner) return;
		for (const agent of listRunAgents(owner, record.runId)) ensureTerminalAgent(owner, record, agent);
	}

	function retireRun(run: { runId: string; team: string }): boolean {
		const owner = ownerOf(run.team);
		if (!owner) return true;
		let complete = true;
		for (const agent of listRunAgents(owner, run.runId)) {
			const family = familyOfAgent(owner, agent.agentId);
			if (!family) continue;
			for (const operation of agent.operations) {
				if (operation.state === "requested") abandon(owner, family, agent.agentId, operation.operationId);
			}
			const current = listAgent(owner, family, agent.agentId);
			if (current && !ensureTerminalAgent(owner, run, current)) complete = false;
		}
		return complete;
	}

	const port: WorkflowDispatchPort = {
		dispatch(call, settleCall) {
			if (stopped) return;
			const task: PendingCall = {
				issued: call,
				settle: settleCall,
				done: false,
				running: false,
				changedBy: null,
				waitFor: null,
			};
			pending.set(taskKey(call), task);
			if (call.backend === "claude") applyQueuedClaudeResult(task);
			fireAndForget("workflow dispatch", attempt(task));
		},
		settled(call) {
			if (call.backend === "claude") {
				resolveClaudeWaiters(call);
				return;
			}
			if (call.options.thread) return;
			const backend = call.backend;
			const rows = deps.runner.rows(call.runId);
			const turn = rows
				.filter(
					(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
						row.kind === "turn" && row.issueOrdinal === call.issueOrdinal,
				)
				.sort((left, right) => right.turnOrdinal - left.turnOrdinal)[0];
			if (!turn?.agentId || !turn.target) return;
			const owner = ownerOf(call.team);
			if (!owner) return;
			const agent = listAgent(owner, backend, turn.agentId);
			if (agent && (agent.state === "idle" || agent.state === "unavailable"))
				retire(owner, backend, agent.agentId);
			else if (agent)
				watchIdle(owner, backend, agent.agentId, (current) => {
					if (current?.state === "idle" || current?.state === "unavailable")
						retire(owner, backend, agent.agentId);
				});
		},
		terminal(record) {
			terminal(record);
		},
		hostRegistering() {
			registering = true;
		},
		hostRegistered() {
			registering = false;
			const liveInstanceId = deps.readLiveness().daemonInstanceId;
			for (const task of pending.values()) {
				if (task.done || task.issued.backend !== "claude") continue;
				const turn = latestTurn(task);
				if (!turn || turn.registerInstanceId === liveInstanceId) continue;
				settle(task, {
					outcome: "interrupted",
					answer: null,
					reason: "runner lost: the host daemon restarted",
				});
			}
			retryPending("register");
		},
		catalogChanged() {
			retryPending("catalog");
		},
		tick() {
			retryPending("tick");
			retryOwedCancels();
		},
		stop() {
			stopped = true;
			rejectClaudeWaiters(new Error("workflow dispatch stopped"));
			for (const task of pending.values()) detach(task);
			pending.clear();
			for (const unsubscribe of idleListeners.values()) unsubscribe();
			idleListeners.clear();
		},
	};

	return {
		port,
		claudeTurnResult,
		retireRun,
		inspectThread({ team, agentId }) {
			const owner = ownerOf(team);
			if (!owner) return null;
			const agent = listAgent(owner, "codex", agentId) ?? listAgent(owner, "copilot", agentId);
			return agent ? { state: agent.state, ...(agent.runId ? { runId: agent.runId } : {}) } : null;
		},
		retagThread({ team, agentId, fromRunId, toRunId }) {
			const owner = ownerOf(team);
			if (!owner) return false;
			if (deps.codex.list(owner).some((agent) => agent.agentId === agentId)) {
				return deps.codex.retagRun(owner, agentId, fromRunId, toRunId, deps.ambient.now());
			}
			return deps.copilot.retagRun(owner, agentId, fromRunId, toRunId, deps.ambient.now());
		},
	};
}

function parseTarget(raw: string | null): AgentExecutionTarget | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as AgentExecutionTarget;
		if (value && (value.kind === "host" || value.kind === "devcontainer")) return value;
	} catch {}
	return undefined;
}
