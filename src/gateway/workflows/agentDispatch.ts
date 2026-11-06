import crypto from "node:crypto";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { AGENT_PROMPT_MAX_BYTES, AGENT_TURN_LOST_REASON } from "../../shared/agent-record.js";
import type { Ambient } from "../../shared/ambient.js";
import { type CodexPersistedAgent, codexAgentIdForOperation } from "../../shared/codex-agent.js";
import { type CopilotPersistedAgent, copilotAgentIdForOperation } from "../../shared/copilot-agent.js";
import { type HostOpResult, HostReadSkillResultSchema } from "../../shared/host-op.js";
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
	relayToHost: (op: { kind: "readSkill"; target: AgentExecutionTarget; path: string }) => Promise<HostOpResult>;
	codex: CodexAgentCommands;
	copilot: CopilotAgentCommands;
	codexRelay: CodexRelay;
	copilotRelay: CopilotRelay;
}

function taskKey(call: WorkflowIssuedCall): string {
	return `${call.runId}:${call.issueOrdinal}`;
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
	retireRun(run: { runId: string; team: string }): boolean;
	inspectThread(input: { team: string; agentId: string }): { state: string; runId?: string } | null;
	retagThread(input: { team: string; agentId: string; fromRunId: string; toRunId: string }): boolean;
}

export function createWorkflowAgentDispatch(deps: WorkflowAgentDispatchDeps): WorkflowAgentDispatch {
	const pending = new Map<string, PendingCall>();
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
		operationId: string,
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

	async function attempt(task: PendingCall): Promise<void> {
		if (stopped || task.done || task.running) return;
		if (task.issued.backend === "claude") {
			settle(task, { outcome: "unavailable", answer: null, reason: "claude backend is not served" });
			return;
		}
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
			if (owner && task.lastAgentId && task.lastOperationId) {
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
		if (task.issued.backend === "claude") return;
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

	function reconcileTerminalRuns(): void {
		if (stopped) return;
		for (const record of deps.runner.runs()) {
			if (record.status === "running") continue;
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
			fireAndForget("workflow dispatch", attempt(task));
		},
		settled(call) {
			if (call.options.thread) return;
			if (call.backend === "claude") return;
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
			retryPending("register");
		},
		catalogChanged() {
			retryPending("catalog");
		},
		tick() {
			retryPending("tick");
		},
		stop() {
			stopped = true;
			for (const task of pending.values()) detach(task);
			pending.clear();
			for (const unsubscribe of idleListeners.values()) unsubscribe();
			idleListeners.clear();
		},
	};

	return {
		port,
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
