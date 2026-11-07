import Ajv from "ajv";
import { AGENT_PROMPT_MAX_BYTES } from "../../shared/agent-record.js";
import type { Ambient } from "../../shared/ambient.js";
import type { WorkflowAgentOutcome } from "../../shared/workflow-agent-outcome.js";
import {
	callFingerprint,
	joinThread,
	parseCallOptions,
	type ThreadOptions,
	threadOptionsOf,
	type WorkflowBackend,
} from "./callOptions.js";
import type { WorkflowRunner, WorkflowStartResult } from "./runner.js";
import { extractWorkflowScript, type WorkflowScript, WorkflowScriptError } from "./script.js";
import {
	createQuickJSScriptValidator,
	createWorkflowVm,
	type WorkflowScriptValidator,
	type WorkflowVm,
	type WorkflowVmHost,
} from "./vm.js";
import {
	type JsonValue,
	JsonValueSchema,
	type WorkflowCallOptions,
	type WorkflowIssueRow,
	type WorkflowJournalRow,
	type WorkflowRunRecord,
	type WorkflowSettleRow,
	WorkflowStartInputSchema,
} from "./workflowSchemas.js";

const SCRIPT_MAX_BYTES = 256 * 1024;
const ARGS_MAX_BYTES = 64 * 1024;
const RESULT_MAX_BYTES = 64 * 1024;
const LOG_LINE_MAX_BYTES = 1024;
const LOG_MAX_LINES = 200;
const ISSUE_LIMIT = 200;
const DISPATCH_LIMIT = 8;
const MAX_CORRECTIONS = 2;
const VALIDATION_LOAD_RETRY_MS = 1_000;

const ajv = new Ajv({ strict: false, allErrors: true });

export interface WorkflowCorrectionRequest {
	attempt: 1 | 2;
	answer: JsonValue;
	errors: string[];
}

export interface WorkflowIssuedCall {
	runId: string;
	team: string;
	issueOrdinal: number;
	callHash: string;
	prompt: string;
	backend: WorkflowBackend;
	options: WorkflowCallOptions;
	threadMode: "start" | "message";
	threadAgent?: Extract<WorkflowJournalRow, { kind: "thread_map" }>;
	correction?: WorkflowCorrectionRequest;
}

export type WorkflowDispatchOutcome =
	| {
			outcome: "completed";
			answer: JsonValue;
			reason: null;
			threadMap?: Extract<WorkflowJournalRow, { kind: "thread_map" }>;
	  }
	| {
			outcome: Exclude<WorkflowAgentOutcome, "completed">;
			answer: JsonValue | null;
			reason: string;
			threadMap?: Extract<WorkflowJournalRow, { kind: "thread_map" }>;
	  };

export type WorkflowDispatchSettle = (outcome: WorkflowDispatchOutcome) => void;

export interface WorkflowDispatchPort {
	dispatch(call: WorkflowIssuedCall, settle: WorkflowDispatchSettle): void;
	settled?(call: WorkflowIssuedCall, outcome: WorkflowDispatchOutcome): void;
	terminal?(record: WorkflowRunRecord, status: WorkflowRunRecord["status"]): void;
	hostRegistering?(): void;
	hostRegistered?(): void;
	catalogChanged?(): void;
	tick?(): void;
	stop?(): void;
}

export interface WorkflowThreadAdoptionPort {
	inspect(input: { team: string; agentId: string }): { state: string; runId?: string } | null;
	retag(input: { team: string; agentId: string; fromRunId: string; toRunId: string }): boolean;
}

export interface WorkflowEngineDeps {
	runner: WorkflowRunner;
	ambient: Pick<Ambient, "now" | "newId">;
	dispatch: WorkflowDispatchPort;
	threadAdoption?: WorkflowThreadAdoptionPort;
	scriptValidator?: WorkflowScriptValidator;
	onChanged?: (team: string) => void;
}

export type WorkflowEngineStartResult =
	| WorkflowStartResult
	| { kind: "invalid_script"; error: WorkflowScriptError }
	| { kind: "invalid_resume"; reason: string }
	| { kind: "not_ready"; retryable: true };

export interface WorkflowEngine {
	start(): boolean;
	startRun(input: unknown): WorkflowEngineStartResult;
	whenReady(): Promise<void>;
	cancel(runId: string): boolean;
	replay(runId: string): boolean;
	tick(): void;
	hostRegistering(): void;
	hostRegistered(): void;
	catalogChanged(): void;
	forgetSession(team: string): void;
	reserves(team: string): boolean;
	logs(runId: string): string[];
	phase(runId: string): string | null;
	stop(): void;
}

interface CallState {
	issued: WorkflowIssuedCall;
	issueRow: WorkflowIssueRow;
	validator?: ReturnType<typeof ajv.compile>;
	queued: boolean;
	dispatched: boolean;
	settled: boolean;
	corrections: number;
	settleAttempt: number;
}

interface ThreadState extends ThreadOptions {
	active: boolean;
	agent: Extract<WorkflowJournalRow, { kind: "thread_map" }> | null;
}

interface ResumeSource {
	record: WorkflowRunRecord;
	rows: WorkflowJournalRow[];
}

interface RunState {
	record: WorkflowRunRecord;
	script: WorkflowScript;
	mode: "live" | "restart" | "resume";
	resumeSource?: ResumeSource;
	vm: WorkflowVm;
	calls: Map<number, CallState>;
	threads: Map<string, ThreadState>;
	waiting: CallState[];
	entryQueue: Array<() => void>;
	entryRunning: boolean;
	issueOrdinal: number;
	settleOrdinal: number;
	issueBuffer: WorkflowIssueRow[];
	phase: string | null;
	logs: string[];
	issuedCount: number;
	dispatchCount: number;
	resumeSettleIndex: number;
	resumeDone: boolean;
	resumeMismatchAt: number | null;
	releasedIssueOrdinals: Set<number>;
	dead: boolean;
	failed: boolean;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function byteSize(value: JsonValue): number {
	return utf8Bytes(JSON.stringify(value));
}

function extractError(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "workflow failed";
	}
}

function createRunState(
	record: WorkflowRunRecord,
	script: WorkflowScript,
	mode: RunState["mode"],
	vm: WorkflowVm,
	resumeSource?: ResumeSource,
): RunState {
	const state: RunState = {
		record,
		script,
		mode,
		...(resumeSource ? { resumeSource } : {}),
		vm,
		calls: new Map(),
		threads: new Map(),
		waiting: [],
		entryQueue: [],
		entryRunning: false,
		issueOrdinal: 0,
		settleOrdinal: 0,
		issueBuffer: [],
		phase: null,
		logs: [],
		issuedCount: 0,
		dispatchCount: 0,
		resumeSettleIndex: 0,
		resumeDone: mode !== "resume",
		resumeMismatchAt: null,
		releasedIssueOrdinals: new Set(),
		dead: false,
		failed: false,
	};
	if (mode === "restart" && resumeSource) {
		for (const row of resumeSource.rows) {
			if (row.kind === "issue" && row.options.thread) {
				if (row.resolvedBackend === "claude") continue;
				if (!state.threads.has(row.options.thread)) {
					state.threads.set(row.options.thread, {
						...threadOptionsOf(row.resolvedBackend, row.options),
						active: false,
						agent: null,
					});
				}
			}
			if (row.kind === "thread_map") {
				const thread = state.threads.get(row.thread);
				if (thread) thread.agent = row;
			}
			if (row.kind === "settle") state.settleOrdinal = Math.max(state.settleOrdinal, row.settleOrdinal);
		}
	}
	return state;
}

function issueRows(rows: WorkflowJournalRow[]): Map<number, WorkflowIssueRow> {
	return new Map(
		rows.filter((row): row is WorkflowIssueRow => row.kind === "issue").map((row) => [row.issueOrdinal, row]),
	);
}

function settleRows(rows: WorkflowJournalRow[]): WorkflowSettleRow[] {
	return rows
		.filter((row): row is WorkflowSettleRow => row.kind === "settle")
		.sort((left, right) => left.settleOrdinal - right.settleOrdinal);
}

function settleOutcome(row: WorkflowSettleRow): WorkflowDispatchOutcome {
	if (row.outcome === "completed") return { outcome: "completed", answer: row.answer, reason: null };
	return { outcome: row.outcome, answer: row.answer, reason: row.reason ?? "step did not complete" };
}

function rowsForResume(source: ResumeSource, issueOrdinal: number): WorkflowJournalRow[] {
	return source.rows.filter((row) => row.kind === "turn" && row.issueOrdinal === issueOrdinal);
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
	const { runner, ambient, dispatch, threadAdoption } = deps;
	const scriptValidator = deps.scriptValidator ?? createQuickJSScriptValidator();
	let started = false;
	let stopped = false;
	let validationReady: Promise<void> = Promise.resolve();
	let validationLoading = false;
	let validationAttemptedAt = Number.NEGATIVE_INFINITY;
	const active = new Map<string, RunState>();
	const preparing = new Set<string>();

	const loadValidationModule = (): Promise<void> => {
		if (stopped || scriptValidator.ready() || validationLoading) return validationReady;
		const now = ambient.now();
		if (now - validationAttemptedAt < VALIDATION_LOAD_RETRY_MS) return validationReady;
		validationAttemptedAt = now;
		validationLoading = true;
		let load: Promise<void>;
		try {
			load = scriptValidator.load();
		} catch (error) {
			load = Promise.reject(error);
		}
		validationReady = Promise.resolve(load)
			.catch((error) => {
				console.error(`[workflow] validation module load failed: ${extractError(error)}`);
			})
			.finally(() => {
				validationLoading = false;
			});
		return validationReady;
	};

	const terminalize = (
		run: RunState,
		status: "succeeded" | "failed" | "cancelled",
		result: JsonValue | null,
		reason: string | null,
	) => {
		if (run.dead) return;
		const changed = runner.transition(run.record.runId, "running", status, {
			result,
			failureReason: reason,
		});
		if (changed) {
			run.record = runner.get(run.record.runId) ?? run.record;
			dispatch.terminal?.(run.record, status);
			deps.onChanged?.(run.record.team);
		}
		disposeRun(run);
	};

	const disposeRun = (run: RunState): void => {
		if (run.dead) return;
		run.dead = true;
		run.vm.dispose();
		active.delete(run.record.runId);
	};

	const enter = (run: RunState, operation: () => void): void => {
		if (run.dead) return;
		run.entryQueue.push(operation);
		if (run.entryRunning) return;
		run.entryRunning = true;
		try {
			while (!run.dead && run.entryQueue.length > 0) {
				run.entryQueue.shift()?.();
			}
		} finally {
			run.entryRunning = false;
		}
	};

	const callAnswer = (outcome: WorkflowDispatchOutcome): JsonValue =>
		outcome.outcome === "completed" ? outcome.answer : null;

	const appendRow = (run: RunState, row: WorkflowJournalRow): boolean => {
		try {
			return runner.append(run.record.runId, row);
		} catch {
			return false;
		}
	};

	const appendSettle = (run: RunState, call: CallState, outcome: WorkflowDispatchOutcome): boolean => {
		const settleOrdinal = run.settleOrdinal + 1;
		const row: WorkflowSettleRow = {
			kind: "settle",
			settleOrdinal,
			issueOrdinal: call.issued.issueOrdinal,
			outcome: outcome.outcome,
			answer: outcome.answer,
			reason: outcome.reason,
		};
		if (!appendRow(run, row)) return false;
		run.settleOrdinal = settleOrdinal;
		// FIXME: named threads durable a month, per session until forgotten; a crash here loses the mapping.
		if (outcome.threadMap && !appendRow(run, outcome.threadMap)) return false;
		return true;
	};

	const releaseCall = (run: RunState, call: CallState, outcome: WorkflowDispatchOutcome): void => {
		if (call.settled || run.dead || runner.get(run.record.runId)?.status !== "running") return;
		if (outcome.outcome !== "completed" && outcome.reason.length === 0) {
			outcome = { ...outcome, reason: "step failed" };
		}
		if (outcome.outcome === "completed" && call.validator) {
			const valid = call.validator(outcome.answer);
			if (!valid) {
				if (call.corrections < MAX_CORRECTIONS) {
					call.corrections += 1;
					call.settleAttempt += 1;
					const errors = (call.validator.errors ?? []).map(
						(issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`,
					);
					const correction: WorkflowCorrectionRequest = {
						attempt: call.corrections as 1 | 2,
						answer: outcome.answer,
						errors,
					};
					try {
						const thread = call.issued.options.thread
							? run.threads.get(call.issued.options.thread)
							: undefined;
						dispatch.dispatch(
							{
								...call.issued,
								threadMode: thread?.agent ? "message" : "start",
								...(thread?.agent ? { threadAgent: thread.agent } : {}),
								correction,
							},
							(next) =>
								enter(run, () => {
									if (call.settleAttempt !== call.corrections) return;
									releaseCall(run, call, next);
								}),
						);
					} catch (error) {
						releaseCall(run, call, { outcome: "failed", answer: null, reason: extractError(error) });
					}
					return;
				}
				outcome = {
					outcome: "invalid",
					answer: outcome.answer,
					reason: `answer failed schema validation: ${(call.validator.errors ?? [])
						.map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`)
						.join("; ")}`,
				};
			}
		}
		if (outcome.answer !== null && byteSize(outcome.answer) > RESULT_MAX_BYTES) {
			outcome =
				outcome.outcome === "completed"
					? { outcome: "failed", answer: null, reason: "answer exceeds the limit" }
					: { ...outcome, answer: null, reason: `${outcome.reason}; answer exceeds the limit` };
		}
		if (!appendSettle(run, call, outcome)) {
			terminalize(run, "failed", null, "workflow journal settle failed");
			return;
		}
		call.settled = true;
		call.dispatched = false;
		run.dispatchCount = Math.max(0, run.dispatchCount - 1);
		if (call.issued.options.thread) {
			const thread = run.threads.get(call.issued.options.thread);
			if (thread) {
				thread.active = false;
				if (outcome.threadMap) thread.agent = outcome.threadMap;
			}
		}
		dispatch.settled?.(call.issued, outcome);
		run.releasedIssueOrdinals.add(call.issued.issueOrdinal);
		run.vm.settle(call.issued.issueOrdinal, callAnswer(outcome));
		drive(run, true);
	};

	const driveDispatch = (run: RunState): void => {
		if (run.dead || stopped || runner.get(run.record.runId)?.status !== "running") return;
		if (run.mode === "resume" && !run.resumeDone) return;
		while (run.dispatchCount < DISPATCH_LIMIT) {
			const nextIndex = run.waiting.findIndex((call) => {
				if (call.settled || call.dispatched) return false;
				const threadKey = call.issued.options.thread;
				if (!threadKey) return true;
				return run.threads.get(threadKey)?.active !== true;
			});
			if (nextIndex < 0) return;
			const [call] = run.waiting.splice(nextIndex, 1);
			if (!call) return;
			call.dispatched = true;
			run.dispatchCount += 1;
			if (call.issued.options.thread) {
				const thread = run.threads.get(call.issued.options.thread);
				if (thread) thread.active = true;
			}
			const thread = call.issued.options.thread ? run.threads.get(call.issued.options.thread) : undefined;
			const issued: WorkflowIssuedCall = thread
				? {
						...call.issued,
						threadMode: thread.agent ? "message" : "start",
						...(thread.agent ? { threadAgent: thread.agent } : {}),
					}
				: call.issued;
			try {
				const attempt = call.settleAttempt;
				dispatch.dispatch(issued, (outcome) =>
					enter(run, () => {
						if (call.settleAttempt === attempt) releaseCall(run, call, outcome);
					}),
				);
			} catch (error) {
				enter(run, () =>
					releaseCall(run, call, { outcome: "failed", answer: null, reason: extractError(error) }),
				);
			}
		}
	};

	const declaredPhase = (run: RunState, title: string): string => {
		if (!run.script.phases.includes(title)) throw new Error(`unknown workflow phase: ${title}`);
		return title;
	};

	const hostOf = (run: RunState): WorkflowVmHost => ({
		issue: (prompt, optionValue) => issueCall(run, prompt, optionValue),
		log: (text) => {
			if (run.logs.length >= LOG_MAX_LINES) return;
			run.logs.push(new TextDecoder().decode(new TextEncoder().encode(text).slice(0, LOG_LINE_MAX_BYTES)));
		},
		phase: (title) => {
			run.phase = declaredPhase(run, title);
		},
	});

	const issueCall = (run: RunState, prompt: string, optionValue: unknown): number => {
		if (run.dead) throw new Error("workflow ended");
		run.issuedCount += 1;
		if (run.issuedCount > ISSUE_LIMIT) throw new Error("agent call cap exceeded");
		if (utf8Bytes(prompt) > AGENT_PROMPT_MAX_BYTES) throw new Error("agent prompt exceeds the limit");
		const { backend, options } = parseCallOptions(optionValue, run.record.defaultBackend);
		// Explicit phases override current.
		if (options.phase !== undefined) declaredPhase(run, options.phase);
		else if (run.phase !== null) options.phase = run.phase;
		const threadKey = options.thread;
		let threadMode: "start" | "message" = "start";
		if (threadKey) {
			const held = run.threads.get(threadKey);
			if (held) {
				threadMode = "message";
				joinThread(threadKey, held, backend, prompt, options);
			} else {
				run.threads.set(threadKey, { ...threadOptionsOf(backend, options), active: false, agent: null });
			}
		}
		let validator: ReturnType<typeof ajv.compile> | undefined;
		if (options.schema !== undefined) {
			try {
				validator = ajv.compile(options.schema);
			} catch (error) {
				throw new Error(`schema cannot be compiled: ${extractError(error)}`);
			}
		}
		const issueOrdinal = ++run.issueOrdinal;
		const callHash = callFingerprint(prompt, backend, options);
		const issued: WorkflowIssuedCall = {
			runId: run.record.runId,
			team: run.record.team,
			issueOrdinal,
			callHash,
			prompt,
			backend,
			options,
			threadMode,
		};
		const issueRow: WorkflowIssueRow = {
			kind: "issue",
			issueOrdinal,
			callHash,
			prompt,
			resolvedBackend: backend,
			options,
		};
		const prior = run.resumeSource ? issueRows(run.resumeSource.rows).get(issueOrdinal) : undefined;
		if (prior && prior.callHash !== callHash) {
			if (run.mode === "restart") {
				terminalize(run, "failed", null, `replay mismatch at call ${issueOrdinal}`);
				throw new Error(`replay mismatch at call ${issueOrdinal}`);
			}
			run.resumeMismatchAt ??= issueOrdinal;
			run.resumeDone = true;
			adoptResumeThreads(run);
		}
		const existingIssue =
			run.mode === "restart" ? issueRows(runner.rows(run.record.runId)).get(issueOrdinal) : undefined;
		if (!existingIssue) run.issueBuffer.push(issueRow);
		const call: CallState = {
			issued,
			issueRow,
			...(validator ? { validator } : {}),
			queued: true,
			dispatched: false,
			settled: false,
			corrections: 0,
			settleAttempt: 0,
		};
		run.calls.set(issueOrdinal, call);
		run.waiting.push(call);
		return issueOrdinal;
	};

	const scriptState = (run: RunState): "pending" | "fulfilled" | "rejected" => {
		const result = run.vm.result();
		if (result.type === "fulfilled") {
			const parsed = JsonValueSchema.safeParse(result.value);
			if (!parsed.success || byteSize(parsed.data) > RESULT_MAX_BYTES) {
				terminalize(run, "failed", null, "workflow result is not JSON or exceeds the limit");
				return "rejected";
			}
			terminalize(run, "succeeded", parsed.data, null);
			return "fulfilled";
		}
		if (result.type === "rejected") {
			terminalize(run, "failed", null, result.reason);
			return "rejected";
		}
		return "pending";
	};

	const appendResumeCopy = (
		run: RunState,
		row: WorkflowJournalRow,
		kind: "settle" | "turn" | "thread map" | "skill text",
	): boolean => {
		if (appendRow(run, row)) return true;
		terminalize(run, "failed", null, `workflow resume ${kind} copy failed`);
		return false;
	};

	const copyResumeTurns = (run: RunState, issueOrdinal: number): boolean => {
		if (!run.resumeSource) return true;
		for (const row of rowsForResume(run.resumeSource, issueOrdinal)) {
			if (!appendResumeCopy(run, row, "turn")) return false;
		}
		for (const row of run.resumeSource.rows) {
			if (row.kind === "thread_map" && row.lastIssueOrdinal === issueOrdinal) {
				if (!appendResumeCopy(run, row, "thread map")) return false;
			}
		}
		const sourceIssue = issueRows(run.resumeSource.rows).get(issueOrdinal);
		const skillPaths = new Set(sourceIssue?.options.skills ?? []);
		const skillHashes = new Set<string>();
		for (const row of run.resumeSource.rows) {
			if (row.kind === "skill_text" && skillPaths.has(row.path)) skillHashes.add(row.sha256);
		}
		for (const row of run.resumeSource.rows) {
			if (row.kind === "skill_text" && skillHashes.has(row.sha256)) {
				if (!appendResumeCopy(run, row, "skill text")) return false;
			}
		}
		return true;
	};

	const adoptResumeThreads = (run: RunState): void => {
		if (run.mode !== "resume" || !run.resumeSource || !threadAdoption) return;
		const source = run.resumeSource;
		const latest = new Map<string, Extract<WorkflowJournalRow, { kind: "thread_map" }>>();
		for (const row of source.rows) if (row.kind === "thread_map") latest.set(row.thread, row);
		for (const row of latest.values()) {
			if (!run.releasedIssueOrdinals.has(row.lastIssueOrdinal)) continue;
			const held = threadAdoption.inspect({ team: run.record.team, agentId: row.agentId });
			if (held?.state !== "idle" || held.runId !== source.record.runId) continue;
			if (
				!threadAdoption.retag({
					team: run.record.team,
					agentId: row.agentId,
					fromRunId: source.record.runId,
					toRunId: run.record.runId,
				})
			)
				continue;
			const thread = run.threads.get(row.thread);
			if (thread) thread.agent = row;
		}
	};

	const resumeSourceSettles = (run: RunState): WorkflowSettleRow[] =>
		run.resumeSource ? settleRows(run.resumeSource.rows) : [];

	const tryReplay = (run: RunState, live: boolean): boolean => {
		if (!run.resumeSource || run.mode === "live" || run.dead) return false;
		const oldIssues = issueRows(run.resumeSource.rows);
		const oldSettles = resumeSourceSettles(run);
		if (run.mode === "resume" && run.resumeDone) return false;
		while (run.resumeSettleIndex < oldSettles.length) {
			const row = oldSettles[run.resumeSettleIndex]!;
			const priorIssue = oldIssues.get(row.issueOrdinal);
			const call = run.calls.get(row.issueOrdinal);
			if (!priorIssue) {
				if (run.mode === "restart") {
					terminalize(run, "failed", null, `replay missing call ${row.issueOrdinal}`);
				} else {
					run.resumeMismatchAt ??= row.issueOrdinal;
					run.resumeDone = true;
					adoptResumeThreads(run);
				}
				return false;
			}
			if (!call) {
				if (run.mode === "restart") {
					terminalize(run, "failed", null, `replay missing call ${row.issueOrdinal}`);
					return false;
				}
				run.resumeMismatchAt ??= row.issueOrdinal;
				run.resumeDone = true;
				adoptResumeThreads(run);
				return false;
			}
			if (priorIssue.callHash !== call.issued.callHash) {
				if (run.mode === "restart")
					terminalize(run, "failed", null, `replay mismatch at call ${row.issueOrdinal}`);
				else {
					run.resumeMismatchAt ??= row.issueOrdinal;
					run.resumeDone = true;
					adoptResumeThreads(run);
				}
				return false;
			}
			if (row.outcome !== "completed") {
				if (run.mode === "restart") {
					run.resumeSettleIndex += 1;
					call.settled = true;
					run.settleOrdinal = Math.max(run.settleOrdinal, row.settleOrdinal);
					run.vm.settle(call.issued.issueOrdinal, callAnswer(settleOutcome(row)));
					run.vm.drain(live);
					flushIssues(run);
					continue;
				}
				run.resumeMismatchAt ??= row.issueOrdinal;
				run.resumeDone = true;
				adoptResumeThreads(run);
				return false;
			}
			if (run.mode === "resume") {
				if (!copyResumeTurns(run, row.issueOrdinal)) return false;
				if (!appendResumeCopy(run, row, "settle")) return false;
			}
			run.resumeSettleIndex += 1;
			call.settled = true;
			run.settleOrdinal = Math.max(run.settleOrdinal, row.settleOrdinal);
			run.releasedIssueOrdinals.add(row.issueOrdinal);
			run.vm.settle(call.issued.issueOrdinal, callAnswer(settleOutcome(row)));
			run.vm.drain(live);
			flushIssues(run);
		}
		if (run.mode === "resume") {
			run.resumeDone = true;
			adoptResumeThreads(run);
		}
		return false;
	};

	function flushIssues(run: RunState): void {
		if (run.issueBuffer.length === 0) return;
		const rows = run.issueBuffer.splice(0);
		for (const row of rows) {
			if (!appendRow(run, row)) {
				terminalize(run, "failed", null, `workflow issue ${row.issueOrdinal} could not be journaled`);
				return;
			}
		}
	}

	function drive(run: RunState, live: boolean): void {
		if (run.dead || stopped || runner.get(run.record.runId)?.status !== "running") return;
		try {
			run.vm.drain(live);
			flushIssues(run);
			if (run.dead) return;
			tryReplay(run, live);
			if (run.dead) return;
			if (run.mode === "resume" && !run.resumeDone) return;
			const result = scriptState(run);
			if (result !== "pending") return;
			const unsettled = [...run.calls.values()].some((call) => !call.settled);
			if (!unsettled) {
				if (
					run.mode === "restart" &&
					run.resumeSource &&
					run.resumeSettleIndex < resumeSourceSettles(run).length
				) {
					driveDispatch(run);
					return;
				}
				terminalize(run, "failed", null, "script stalled");
				return;
			}
			driveDispatch(run);
		} catch (error) {
			terminalize(run, "failed", null, extractError(error));
		}
	}

	const prepare = (run: RunState): void => {
		try {
			if (stopped || run.dead || runner.get(run.record.runId)?.status !== "running") return;
			run.vm.boot(run.script, run.record.args, hostOf(run), run.mode !== "restart");
			enter(run, () => drive(run, run.mode !== "restart"));
		} catch (error) {
			terminalize(run, "failed", null, extractError(error));
		}
	};

	const beginRun = async (
		record: WorkflowRunRecord,
		mode: RunState["mode"],
		resumeSource?: ResumeSource,
		knownScript?: WorkflowScript,
	): Promise<boolean> => {
		if (stopped || active.has(record.runId) || preparing.has(record.runId)) return false;
		preparing.add(record.runId);
		let vm: WorkflowVm | undefined;
		try {
			const script = knownScript ?? extractWorkflowScript(record.script);
			vm = await createWorkflowVm({ ambient });
			if (stopped || runner.get(record.runId)?.status !== "running") {
				vm.dispose();
				return false;
			}
			const state = createRunState(record, script, mode, vm, resumeSource);
			active.set(record.runId, state);
			prepare(state);
			return true;
		} catch (error) {
			vm?.dispose();
			if (runner.transition(record.runId, "running", "failed", { failureReason: extractError(error) })) {
				deps.onChanged?.(record.team);
			}
			return false;
		} finally {
			preparing.delete(record.runId);
		}
	};

	const rowsFor = (runId: string): WorkflowJournalRow[] => runner.rows(runId);

	return {
		start() {
			if (started || stopped) return false;
			if (!runner.start()) return false;
			started = true;
			loadValidationModule();
			for (const record of runner.running())
				void beginRun(record, "restart", { record, rows: rowsFor(record.runId) });
			for (const record of runner.running()) deps.onChanged?.(record.team);
			return true;
		},
		whenReady() {
			return validationReady;
		},
		startRun(input) {
			if (stopped) return { kind: "refused", reason: "stopped" };
			const parsed = WorkflowStartInputSchema.safeParse(input);
			if (!parsed.success) return { kind: "refused", reason: "storage" };
			const existing = runner.existingStart(parsed.data.operationId);
			if (existing) return { kind: "existing", run: existing };
			const capacity = runner.checkStart(parsed.data.team);
			if (capacity.kind === "refused") return capacity;
			if (!scriptValidator.ready()) {
				loadValidationModule();
				return { kind: "not_ready", retryable: true };
			}
			if (utf8Bytes(parsed.data.script) > SCRIPT_MAX_BYTES)
				return {
					kind: "invalid_script",
					error: new WorkflowScriptError("meta_invalid", "workflow script exceeds the limit"),
				};
			if (byteSize(parsed.data.args) > ARGS_MAX_BYTES) return { kind: "refused", reason: "storage" };
			let script: WorkflowScript;
			try {
				script = extractWorkflowScript(parsed.data.script);
			} catch (error) {
				return {
					kind: "invalid_script",
					error:
						error instanceof WorkflowScriptError
							? error
							: new WorkflowScriptError("meta_invalid", extractError(error)),
				};
			}
			let resumeSource: ResumeSource | undefined;
			if (parsed.data.resumeFrom) {
				const source = runner.get(parsed.data.resumeFrom);
				if (!source || source.team !== parsed.data.team || source.status === "running") {
					return { kind: "invalid_resume", reason: "resume source must be a terminal run from this session" };
				}
				resumeSource = { record: source, rows: rowsFor(source.runId) };
			}
			try {
				scriptValidator.validate(script);
			} catch (error) {
				return {
					kind: "invalid_script",
					error:
						error instanceof WorkflowScriptError
							? error
							: new WorkflowScriptError("syntax", extractError(error)),
				};
			}
			const result = runner.startRun({ ...parsed.data, phases: script.phases });
			if (result.kind === "started") {
				deps.onChanged?.(result.run.team);
				void beginRun(result.run, resumeSource ? "resume" : "live", resumeSource, script);
			}
			return result;
		},
		cancel(runId) {
			if (stopped) return false;
			const record = runner.get(runId);
			if (record?.status !== "running") return false;
			const run = active.get(runId);
			if (run) {
				terminalize(run, "cancelled", null, null);
				return runner.get(runId)?.status === "cancelled";
			}
			const changed = runner.transition(runId, "running", "cancelled", {
				result: null,
				failureReason: null,
			});
			if (!changed) return false;
			dispatch.terminal?.(runner.get(runId) ?? record, "cancelled");
			deps.onChanged?.(record.team);
			return true;
		},
		replay(runId) {
			if (stopped || !started) return false;
			const record = runner.get(runId);
			if (record?.status !== "running") return false;
			void beginRun(record, "restart", { record, rows: rowsFor(record.runId) });
			return true;
		},
		tick() {
			if (stopped) return;
			dispatch.tick?.();
			for (const record of runner.running()) {
				const run = active.get(record.runId);
				if (run) enter(run, () => drive(run, run.mode !== "restart"));
				else void beginRun(record, "restart", { record, rows: rowsFor(record.runId) });
			}
		},
		hostRegistering() {
			if (!stopped) dispatch.hostRegistering?.();
		},
		hostRegistered() {
			if (!stopped) dispatch.hostRegistered?.();
		},
		catalogChanged() {
			if (!stopped) dispatch.catalogChanged?.();
		},
		forgetSession(team) {
			if (stopped) return;
			for (const record of runner.runs()) {
				if (record.team !== team) continue;
				if (record.status === "running") {
					const run = active.get(record.runId);
					const changed = runner.transition(record.runId, "running", "cancelled", {
						result: null,
						failureReason: null,
						notified: true,
					});
					if (changed) {
						const current = runner.get(record.runId) ?? { ...record, status: "cancelled" as const };
						dispatch.terminal?.(current, "cancelled");
						deps.onChanged?.(record.team);
					}
					if (run) disposeRun(run);
				} else {
					runner.markNotified(record.runId);
				}
			}
		},
		reserves(team) {
			return !stopped && runner.running().some((record) => record.team === team);
		},
		logs(runId) {
			return [...(active.get(runId)?.logs ?? [])];
		},
		phase(runId) {
			return active.get(runId)?.phase ?? null;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			scriptValidator.stop();
			dispatch.stop?.();
			for (const run of active.values()) disposeRun(run);
			active.clear();
		},
	};
}
