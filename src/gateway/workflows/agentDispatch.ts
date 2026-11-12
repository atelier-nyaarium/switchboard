import { type AgentBackendId, agentBackend } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { AGENT_TURN_LOST_REASON, agentIdForOperation } from "../../shared/agent-record.js";
import type { AgentServiceTier } from "../../shared/agent-state.js";
import type { Ambient } from "../../shared/ambient.js";
import type { ClaudeTurnResultFrame, HostOp, HostOpResult } from "../../shared/host-op.js";
import { startDefaults } from "../../shared/model-family.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import type { AgentStacks } from "../agentStack.js";
import { fireAndForget } from "../fireAndForget.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import { createAgentFamilies } from "./agentFamilies.js";
import { type AgentOperation, type AgentView, answerOutcome, failureOutcome, refusalOutcome } from "./agentViews.js";
import { createClaudeSteps } from "./claudeSteps.js";
import {
	familyTextError,
	latestTurn,
	makeTurn,
	type PendingCall,
	parseTarget,
	taskKey,
	threadMapRow,
} from "./dispatchCore.js";
import { createWorkflowPrompt } from "./dispatchPrompt.js";
import type { WorkflowDispatchOutcome, WorkflowDispatchPort } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import { createTerminalAgents } from "./terminalAgents.js";
import type { WorkflowJournalRow } from "./workflowSchemas.js";
export interface WorkflowAgentDispatchDeps {
	sessionStore: Pick<SessionStore, "getByTeam" | "list" | "teamOf">;
	ambient: Pick<Ambient, "now" | "newId">;
	runner: WorkflowRunner;
	readLiveness: HostLivenessReader;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	stacks: AgentStacks;
	resolveTarget: (owner: SessionRecord) => AgentExecutionTarget | null;
}

export interface WorkflowAgentDispatch {
	port: WorkflowDispatchPort;
	claudeTurnResult(frame: ClaudeTurnResultFrame): Promise<void>;
	retireRun(run: { runId: string; team: string }): boolean;
	inspectThread(input: { team: string; agentId: string }): { state: string; runId?: string } | null;
	retagThread(input: { team: string; agentId: string; fromRunId: string; toRunId: string }): boolean;
}

/** Owns workflow dispatch. */
export function createWorkflowAgentDispatch(deps: WorkflowAgentDispatchDeps): WorkflowAgentDispatch {
	const pending = new Map<string, PendingCall>();
	let stopped = false;
	let registering = false;

	const ownerOf = (team: string): SessionRecord | undefined => deps.sessionStore.getByTeam(team);

	function settle(task: PendingCall, outcome: WorkflowDispatchOutcome): void {
		if (task.done || stopped) return;
		task.done = true;
		task.unsubscribe?.();
		task.unsubscribe = undefined;
		pending.delete(taskKey(task.issued));
		task.settle(outcome);
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
		const mapping = threadMapRow(task, agent.agentId, agent.target);
		if (turn.state === "completed") {
			settle(task, {
				...answerOutcome(turn.finalResponse ?? "", task.issued.options.schema !== undefined),
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
		settle(task, {
			...failureOutcome(turn.error ?? "agent turn failed"),
			...(mapping ? { threadMap: mapping } : {}),
		});
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
		const relay = task.issued.backend === "claude" ? undefined : deps.stacks.get(task.issued.backend)?.relay;
		task.unsubscribe = relay?.onAgentChange(ownerKey, agentId, () => {
			if (stopped || task.done) return;
			fireAndForget("workflow agent change", poll(task));
		});
	}

	function sendCommand(
		task: PendingCall,
		owner: SessionRecord,
		backend: AgentBackendId,
		mode: "start" | "message",
		agentId: string,
		operationId: string,
		prompt: string,
	): { dispatched: boolean; agentId: string } {
		const stack = deps.stacks.get(backend);
		if (!stack) {
			settle(task, { outcome: "unavailable", answer: null, reason: `no ${backend} agents on this Gateway` });
			return { dispatched: false, agentId };
		}
		const { effort, schema: outputSchema } = task.issued.options;
		const named = { model: task.issued.options.model, serviceTier: task.issued.options.tier as AgentServiceTier };
		const { model, serviceTier: tier } = mode === "start" ? startDefaults(agentBackend(backend), named) : named;
		const serviceTier = tier === undefined ? {} : { serviceTier: tier };
		const shared = { operationId, prompt, ...serviceTier, ...(outputSchema === undefined ? {} : { outputSchema }) };
		const result =
			mode === "start"
				? stack.start(owner, {
						...shared,
						...(model === undefined ? {} : { model }),
						...(effort === undefined ? {} : { reasoningEffort: effort }),
						runId: task.issued.runId,
					})
				: stack.message(owner, { ...shared, agentId });
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
		return { dispatched: true, agentId: result.agentId };
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
				claudeSteps.applyQueuedClaudeResult(task);
				if (!task.done) await claudeSteps.attemptClaude(task, owner);
				return;
			}
			const previous = latestTurn(task, deps.runner);
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
			const target = mode === "message" ? existing!.target : deps.stacks.get(backend)?.resolveTarget(owner);
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
						: agentIdForOperation(backend, operationId);
			const currentRow =
				reuseOperation &&
				previous?.registerInstanceId === live.daemonInstanceId &&
				previous.operationId === operationId
					? previous
					: undefined;
			const turn =
				currentRow ??
				makeTurn(task, operationId, agentId, live.daemonInstanceId, target, prompt, deps.runner, () =>
					deps.ambient.newId(),
				);
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
		const turn = latestTurn(task, deps.runner);
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
			const orphans = [...deps.stacks.values()].flatMap((stack) =>
				stack
					.list(owner)
					.filter((agent) => agent.runId && !restored.has(agent.runId))
					.map((agent) => [stack.backend.id, agent.agentId] as const),
			);
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
		claudeSteps.releaseClaudeRun(record.runId);
		claudeSteps.cancelStrandedClaudeTurns(record.runId);
		const owner = ownerOf(record.team);
		if (!owner) return;
		for (const agent of listRunAgents(owner, record.runId)) ensureTerminalAgent(owner, record, agent);
	}

	const families = createAgentFamilies(deps);
	const { snapshot, listRunAgents, listAgent, retire, abandon } = families;
	const terminalAgents = createTerminalAgents(deps, families, ownerOf);
	const { ensureTerminalAgent, watchIdle } = terminalAgents;
	const promptSteps = createWorkflowPrompt(deps, settle, () => stopped);
	const { composePrompt } = promptSteps;
	const claudeSteps = createClaudeSteps({
		deps,
		pending: () => pending,
		isStopped: () => stopped,
		settle,
		attempt,
		composePrompt,
		projectLead: promptSteps.projectLead,
	});

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
			if (call.backend === "claude") claudeSteps.applyQueuedClaudeResult(task);
			fireAndForget("workflow dispatch", attempt(task));
		},
		settled(call) {
			if (call.backend === "claude") {
				claudeSteps.resolveClaudeWaiters(call);
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
			claudeSteps.hostRegistered(liveInstanceId);
			retryPending("register");
		},
		catalogChanged() {
			retryPending("catalog");
		},
		tick() {
			retryPending("tick");
			claudeSteps.retryOwedCancels();
		},
		stop() {
			stopped = true;
			claudeSteps.rejectClaudeWaiters(new Error("workflow dispatch stopped"));
			for (const task of pending.values()) detach(task);
			pending.clear();
			terminalAgents.clearIdleListeners();
		},
	};

	return {
		port,
		claudeTurnResult: claudeSteps.claudeTurnResult,
		retireRun: terminalAgents.retireRun,
		inspectThread({ team, agentId }) {
			const owner = ownerOf(team);
			if (!owner) return null;
			const family = families.familyOfAgent(owner, agentId);
			const agent = family && listAgent(owner, family, agentId);
			return agent ? { state: agent.state, ...(agent.runId ? { runId: agent.runId } : {}) } : null;
		},
		retagThread({ team, agentId, fromRunId, toRunId }) {
			const owner = ownerOf(team);
			if (!owner) return false;
			const family = families.familyOfAgent(owner, agentId);
			const stack = family && deps.stacks.get(family);
			return stack ? stack.retagRun(owner, agentId, fromRunId, toRunId, deps.ambient.now()) : false;
		},
	};
}
