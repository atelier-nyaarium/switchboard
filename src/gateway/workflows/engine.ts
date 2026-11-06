import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import syncVariant from "@jitl/quickjs-wasmfile-release-sync";
import Ajv from "ajv";
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten-core";
import { z } from "zod";
import { AGENT_PROMPT_MAX_BYTES } from "../../shared/agent-record.js";
import type { Ambient } from "../../shared/ambient.js";
import { CodexMessageAgentInputSchema, CodexStartAgentInputSchema } from "../../shared/codexAgentState.js";
import { CopilotMessageAgentInputSchema, CopilotStartAgentInputSchema } from "../../shared/copilotAgentState.js";
import type { WorkflowAgentOutcome } from "../../shared/workflow-agent-outcome.js";
import { WORKFLOW_PRELUDE } from "./prelude.js";
import type { WorkflowRunner, WorkflowStartResult } from "./runner.js";
import { extractWorkflowScript, type WorkflowScript, WorkflowScriptError } from "./script.js";
import {
	type JsonValue,
	JsonValueSchema,
	type WorkflowCallOptions,
	WorkflowCallOptionsSchema,
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
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MEMORY_CHECK_LIMIT_BYTES = 24 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const JOB_BATCH_LIMIT = 256;
const JOB_SLICE_LIMIT = 8192;
const INTERRUPT_TICK_LIMIT = 512;
const LIVE_SLICE_MS = 200;
const MAX_CORRECTIONS = 2;

const require = createRequire(import.meta.url);
const wasmBytes = fs.readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"));
const wasmBinary = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
const compiledWasm = WebAssembly.compile(wasmBinary);
const quickJsVariant = newVariant(syncVariant, { wasmModule: compiledWasm, wasmBinary });
const ajv = new Ajv({ strict: false, allErrors: true });

const commonOptionShape = {
	backend: WorkflowCallOptionsSchema.shape.backend,
	skills: WorkflowCallOptionsSchema.shape.skills,
	thread: WorkflowCallOptionsSchema.shape.thread,
	label: WorkflowCallOptionsSchema.shape.label,
	phase: WorkflowCallOptionsSchema.shape.phase,
};

const CodexCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: CodexStartAgentInputSchema.shape.model,
		tier: CodexStartAgentInputSchema.shape.serviceTier,
		schema: CodexStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const CopilotCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: CopilotStartAgentInputSchema.shape.model,
		effort: CopilotStartAgentInputSchema.shape.reasoningEffort,
		schema: CopilotStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const ClaudeCallOptionsSchema = z
	.object({
		...commonOptionShape,
		model: z.string().optional(),
		effort: WorkflowCallOptionsSchema.shape.effort,
		schema: CodexStartAgentInputSchema.shape.outputSchema,
	})
	.strict();

const CodexMessageOptionsSchema = z
	.object({
		prompt: CodexMessageAgentInputSchema.shape.prompt,
		serviceTier: CodexMessageAgentInputSchema.shape.serviceTier,
		outputSchema: CodexMessageAgentInputSchema.shape.outputSchema,
	})
	.strict();

const CopilotMessageOptionsSchema = z
	.object({
		prompt: CopilotMessageAgentInputSchema.shape.prompt,
		outputSchema: CopilotMessageAgentInputSchema.shape.outputSchema,
	})
	.strict();

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
	backend: NonNullable<WorkflowCallOptions["backend"]>;
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
	onChanged?: (team: string) => void;
}

export type WorkflowEngineStartResult =
	| WorkflowStartResult
	| { kind: "invalid_script"; error: WorkflowScriptError }
	| { kind: "invalid_resume"; reason: string };

export interface WorkflowEngine {
	start(): boolean;
	startRun(input: unknown): WorkflowEngineStartResult;
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
	deferred: QuickJSDeferredPromise | null;
	validator?: ReturnType<typeof ajv.compile>;
	queued: boolean;
	dispatched: boolean;
	settled: boolean;
	corrections: number;
	settleAttempt: number;
}

interface ThreadState {
	backend: NonNullable<WorkflowCallOptions["backend"]>;
	model?: string;
	effort?: WorkflowCallOptions["effort"];
	tier?: WorkflowCallOptions["tier"];
	skills: string[];
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
	moduleReady: Promise<void>;
	module?: Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;
	runtime?: QuickJSRuntime;
	context?: QuickJSContext;
	resultPromise?: QuickJSHandle;
	deferreds: Set<QuickJSDeferredPromise>;
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
	interrupted: boolean;
	memoryExceeded: boolean;
	interruptTicks: number;
	sliceStartedAt: number;
	sliceLive: boolean;
	userCodeActive: boolean;
	dead: boolean;
	failed: boolean;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stableSkills(value: string[] | undefined): string[] {
	return [...(value ?? [])];
}

function callFingerprint(
	prompt: string,
	backend: NonNullable<WorkflowCallOptions["backend"]>,
	options: WorkflowCallOptions,
): string {
	const fields: Record<string, JsonValue> = {
		prompt,
		backend,
		model: options.model ?? null,
		effort: options.effort ?? null,
		tier: options.tier ?? null,
		schema: options.schema ?? null,
		skills: stableSkills(options.skills),
		thread: options.thread ?? null,
	};
	return sha256(canonical(fields));
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
	resumeSource?: ResumeSource,
): RunState {
	const state: RunState = {
		record,
		script,
		mode,
		...(resumeSource ? { resumeSource } : {}),
		moduleReady: Promise.resolve(),
		deferreds: new Set(),
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
		interrupted: false,
		memoryExceeded: false,
		interruptTicks: 0,
		sliceStartedAt: 0,
		sliceLive: mode !== "restart",
		userCodeActive: false,
		dead: false,
		failed: false,
	};
	state.moduleReady = newQuickJSWASMModuleFromVariant(quickJsVariant).then((module) => {
		state.module = module;
	});
	if (mode === "restart" && resumeSource) {
		for (const row of resumeSource.rows) {
			if (row.kind === "issue" && row.options.thread) {
				const backend = row.resolvedBackend;
				if (backend === "claude") continue;
				if (!state.threads.has(row.options.thread)) {
					state.threads.set(row.options.thread, {
						backend,
						...(row.options.model !== undefined ? { model: row.options.model } : {}),
						...(row.options.effort !== undefined ? { effort: row.options.effort } : {}),
						...(row.options.tier !== undefined ? { tier: row.options.tier } : {}),
						skills: stableSkills(row.options.skills),
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
	let started = false;
	let stopped = false;
	const active = new Map<string, RunState>();

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
		for (const deferred of run.deferreds) {
			try {
				deferred.dispose();
			} catch {}
		}
		run.deferreds.clear();
		try {
			run.resultPromise?.dispose();
		} catch {}
		try {
			run.context?.dispose();
		} catch {}
		try {
			run.runtime?.dispose();
		} catch {}
		run.context = undefined;
		run.runtime = undefined;
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

	const readMemory = (run: RunState): number => {
		const runtime = run.runtime;
		const context = run.context;
		if (!runtime || !context) return 0;
		let handle: QuickJSHandle | undefined;
		try {
			handle = runtime.computeMemoryUsage();
			const usage = context.dump(handle) as { memory_used_size?: unknown };
			return typeof usage?.memory_used_size === "number" ? usage.memory_used_size : 0;
		} catch {
			return MEMORY_CHECK_LIMIT_BYTES + 1;
		} finally {
			try {
				handle?.dispose();
			} catch {}
		}
	};

	const settlePromise = (run: RunState, call: CallState, answer: JsonValue): void => {
		const deferred = call.deferred;
		if (!deferred?.alive) return;
		let result: QuickJSHandle | undefined;
		try {
			const literal = JSON.stringify(JSON.stringify(answer));
			const evaluated = run.context?.evalCode(`JSON.parse(${literal})`);
			if (!evaluated || evaluated.error !== undefined) {
				if (evaluated?.error !== undefined) evaluated.error.dispose();
				return;
			}
			result = evaluated.value;
			deferred.resolve(result);
		} finally {
			try {
				result?.dispose();
			} catch {}
			try {
				deferred.dispose();
			} catch {}
			run.deferreds.delete(deferred);
			call.deferred = null;
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
		settlePromise(run, call, callAnswer(outcome));
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

	const hostIssue = (run: RunState, promptHandle: QuickJSHandle, optionsHandle?: QuickJSHandle): QuickJSHandle => {
		const context = run.context;
		if (!context) throw new Error("workflow VM is not ready");
		run.issuedCount += 1;
		if (run.issuedCount > ISSUE_LIMIT) throw new Error("agent call cap exceeded");
		if (context.typeof(promptHandle) !== "string") throw new Error("agent prompt must be a string");
		const prompt = context.getString(promptHandle);
		if (utf8Bytes(prompt) > AGENT_PROMPT_MAX_BYTES) throw new Error("agent prompt exceeds the limit");
		const optionValue = optionsHandle ? context.dump(optionsHandle) : {};
		const parsedOptions = WorkflowCallOptionsSchema.parse(optionValue ?? {});
		const backend = parsedOptions.backend ?? run.record.defaultBackend;
		const familySchema =
			backend === "codex"
				? CodexCallOptionsSchema
				: backend === "copilot"
					? CopilotCallOptionsSchema
					: ClaudeCallOptionsSchema;
		const familyParsed = familySchema.safeParse(parsedOptions);
		if (!familyParsed.success) throw new Error(familyParsed.error.issues[0]?.message ?? "invalid backend options");
		const options = familyParsed.data as WorkflowCallOptions;
		const threadKey = options.thread;
		let threadMode: "start" | "message" = "start";
		if (threadKey) {
			const held = run.threads.get(threadKey);
			if (held) {
				threadMode = "message";
				if (held.backend !== backend) throw new Error(`thread ${threadKey} backend changed`);
				if (options.model !== undefined && options.model !== held.model)
					throw new Error(`thread ${threadKey} model changed`);
				if (options.effort !== undefined && options.effort !== held.effort)
					throw new Error(`thread ${threadKey} effort changed`);
				if (
					options.skills !== undefined &&
					stableSkills(options.skills).join("\n") !== held.skills.join("\n")
				) {
					throw new Error(`thread ${threadKey} skills changed`);
				}
				options.skills ??= [...held.skills];
				options.model ??= held.model;
				options.effort ??= held.effort;
				if (backend === "codex") {
					CodexMessageOptionsSchema.parse({
						prompt,
						serviceTier: options.tier,
						outputSchema: options.schema,
					});
				} else if (backend === "copilot") {
					CopilotMessageOptionsSchema.parse({ prompt, outputSchema: options.schema });
				}
			} else {
				run.threads.set(threadKey, {
					backend,
					...(options.model !== undefined ? { model: options.model } : {}),
					...(options.effort !== undefined ? { effort: options.effort } : {}),
					...(options.tier !== undefined ? { tier: options.tier } : {}),
					skills: stableSkills(options.skills),
					active: false,
					agent: null,
				});
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
			deferred: null,
			...(validator ? { validator } : {}),
			queued: true,
			dispatched: false,
			settled: false,
			corrections: 0,
			settleAttempt: 0,
		};
		const deferred = context.newPromise();
		call.deferred = deferred;
		run.deferreds.add(deferred);
		run.calls.set(issueOrdinal, call);
		run.waiting.push(call);
		return deferred.handle;
	};

	const installGlobals = (run: RunState): void => {
		const context = run.context;
		if (!context) throw new Error("workflow VM is not ready");
		const setFunction = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
			const handle = context.newFunction(name, (...args) => fn(...args));
			context.setProp(context.global, name, handle);
			handle.dispose();
		};
		setFunction("agent", (prompt, options) => hostIssue(run, prompt!, options));
		setFunction("log", (value) => {
			if (run.logs.length >= LOG_MAX_LINES) return context.undefined;
			let rendered = "";
			try {
				const dumped = context.dump(value!);
				rendered = typeof dumped === "string" ? dumped : JSON.stringify(dumped);
			} catch {
				rendered = "[unserializable]";
			}
			run.logs.push(new TextDecoder().decode(new TextEncoder().encode(rendered).slice(0, LOG_LINE_MAX_BYTES)));
			return context.undefined;
		});
		setFunction("phase", (name) => {
			if (context.typeof(name!) !== "string") throw new Error("phase needs a title");
			const title = context.getString(name!);
			if (!run.script.phases.includes(title)) throw new Error(`unknown workflow phase: ${title}`);
			run.phase = title;
			return context.undefined;
		});
	};

	const checkMemory = (run: RunState): void => {
		if (readMemory(run) > MEMORY_CHECK_LIMIT_BYTES) throw new Error("workflow memory budget exceeded");
	};

	const drainJobs = (run: RunState, live: boolean): void => {
		const runtime = run.runtime;
		if (!runtime) return;
		run.interrupted = false;
		run.interruptTicks = 0;
		run.sliceStartedAt = ambient.now();
		run.sliceLive = live;
		let jobs = 0;
		run.userCodeActive = true;
		try {
			while (runtime.hasPendingJob() && jobs < JOB_SLICE_LIMIT) {
				const result = runtime.executePendingJobs(JOB_BATCH_LIMIT);
				if (result.error !== undefined) {
					const reason = extractError(run.context?.dump(result.error));
					result.dispose();
					if (run.interrupted)
						throw new Error(
							run.memoryExceeded
								? "workflow memory budget exceeded"
								: "workflow instruction budget exceeded",
						);
					throw new Error(reason);
				}
				const executed = result.value;
				jobs += executed;
				result.dispose();
				if (run.interrupted)
					throw new Error(
						run.memoryExceeded ? "workflow memory budget exceeded" : "workflow instruction budget exceeded",
					);
				checkMemory(run);
				if (executed === 0) break;
				if (jobs >= JOB_SLICE_LIMIT && runtime.hasPendingJob()) throw new Error("workflow job budget exceeded");
			}
		} finally {
			run.userCodeActive = false;
		}
	};

	const scriptState = (run: RunState): "pending" | "fulfilled" | "rejected" => {
		if (!run.context || !run.resultPromise) return "pending";
		const state = run.context.getPromiseState(run.resultPromise);
		if (state.type === "fulfilled") {
			const value = run.context.dump(state.value);
			state.value.dispose();
			const parsed = JsonValueSchema.safeParse(value);
			if (!parsed.success || byteSize(parsed.data) > RESULT_MAX_BYTES) {
				terminalize(run, "failed", null, "workflow result is not JSON or exceeds the limit");
				return "rejected";
			}
			terminalize(run, "succeeded", parsed.data, null);
			return "fulfilled";
		}
		if (state.type === "rejected") {
			const reason = extractError(run.context.dump(state.error));
			state.error.dispose();
			terminalize(run, "failed", null, reason);
			return "rejected";
		}
		return "pending";
	};

	const copyResumeTurns = (run: RunState, issueOrdinal: number): void => {
		if (!run.resumeSource) return;
		for (const row of rowsForResume(run.resumeSource, issueOrdinal)) appendRow(run, row);
		for (const row of run.resumeSource.rows) {
			if (row.kind === "thread_map" && row.lastIssueOrdinal === issueOrdinal) appendRow(run, row);
		}
		const sourceIssue = issueRows(run.resumeSource.rows).get(issueOrdinal);
		const skillPaths = new Set(sourceIssue?.options.skills ?? []);
		const skillHashes = new Set<string>();
		for (const row of run.resumeSource.rows) {
			if (row.kind === "skill_text" && skillPaths.has(row.path)) skillHashes.add(row.sha256);
		}
		for (const row of run.resumeSource.rows) {
			if (row.kind === "skill_text" && skillHashes.has(row.sha256)) appendRow(run, row);
		}
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
			appendRow(run, row);
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
					settlePromise(run, call, callAnswer(settleOutcome(row)));
					drainJobs(run, live);
					flushIssues(run);
					continue;
				}
				run.resumeMismatchAt ??= row.issueOrdinal;
				run.resumeDone = true;
				adoptResumeThreads(run);
				return false;
			}
			if (run.mode === "resume") {
				appendRow(run, row);
				copyResumeTurns(run, row.issueOrdinal);
			}
			run.resumeSettleIndex += 1;
			call.settled = true;
			run.settleOrdinal = Math.max(run.settleOrdinal, row.settleOrdinal);
			run.releasedIssueOrdinals.add(row.issueOrdinal);
			settlePromise(run, call, callAnswer(settleOutcome(row)));
			drainJobs(run, live);
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
			drainJobs(run, live);
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
			terminalize(
				run,
				"failed",
				null,
				run.memoryExceeded
					? "workflow memory budget exceeded"
					: run.interrupted
						? "workflow instruction budget exceeded"
						: extractError(error),
			);
		}
	}

	const attachJsonGlobal = (run: RunState, name: string, value: JsonValue): void => {
		const context = run.context;
		if (!context) throw new Error("workflow VM is not ready");
		const literal = JSON.stringify(JSON.stringify(value));
		const result = context.evalCode(
			`globalThis.${name} = (() => { const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) freeze(value[key]); } return value; }; return freeze(JSON.parse(${literal})); })();`,
		);
		if (result.error !== undefined) {
			const message = extractError(context.dump(result.error));
			result.error.dispose();
			throw new Error(message);
		}
		result.value.dispose();
	};

	const prepare = async (run: RunState): Promise<void> => {
		try {
			await run.moduleReady;
			if (stopped || run.dead || runner.get(run.record.runId)?.status !== "running") return;
			const module = run.module;
			if (!module) throw new Error("QuickJS module is unavailable");
			run.runtime = module.newRuntime({
				memoryLimitBytes: MEMORY_LIMIT_BYTES,
				maxStackSizeBytes: STACK_LIMIT_BYTES,
				interruptHandler: () => {
					if (!run.userCodeActive) return false;
					run.interruptTicks += 1;
					if (run.interruptTicks % 2 === 0) {
						let usage = 0;
						let handle: QuickJSHandle | undefined;
						try {
							handle = run.runtime?.computeMemoryUsage();
							usage =
								handle && run.context
									? ((run.context.dump(handle) as { memory_used_size?: number }).memory_used_size ??
										0)
									: 0;
						} catch {
							usage = MEMORY_CHECK_LIMIT_BYTES + 1;
						} finally {
							try {
								handle?.dispose();
							} catch {}
						}
						if (usage > MEMORY_CHECK_LIMIT_BYTES) {
							run.memoryExceeded = true;
							run.interrupted = true;
							return true;
						}
					}
					if (run.interruptTicks > INTERRUPT_TICK_LIMIT) {
						run.interrupted = true;
						return true;
					}
					if (run.sliceLive && ambient.now() - run.sliceStartedAt > LIVE_SLICE_MS) {
						run.interrupted = true;
						return true;
					}
					return false;
				},
			});
			run.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
			run.runtime.setMaxStackSize(STACK_LIMIT_BYTES);
			const metaContext = run.runtime.newContext();
			try {
				const metaSource = JSON.stringify(run.script.metaLiteral);
				const metaResult = metaContext.evalCode(`const meta = JSON.parse(${metaSource}); meta`);
				if (metaResult.error !== undefined) {
					const reason = extractError(metaContext.dump(metaResult.error));
					metaResult.error.dispose();
					throw new Error(reason);
				}
				const parsedMeta = JsonValueSchema.parse(metaContext.dump(metaResult.value));
				metaResult.value.dispose();
				if (canonical(parsedMeta) !== canonical(run.script.meta))
					throw new Error("meta did not evaluate as JSON");
			} finally {
				metaContext.dispose();
			}
			run.context = run.runtime.newContext();
			installGlobals(run);
			run.interrupted = false;
			run.interruptTicks = 0;
			run.sliceStartedAt = ambient.now();
			run.sliceLive = run.mode !== "restart";
			const prelude = run.context.evalCode(WORKFLOW_PRELUDE);
			if (prelude.error !== undefined) {
				const reason = extractError(run.context.dump(prelude.error));
				prelude.error.dispose();
				throw new Error(reason);
			}
			prelude.value.dispose();
			attachJsonGlobal(run, "args", run.record.args);
			attachJsonGlobal(run, "meta", run.script.meta);
			const wrapper = `(async () => {\n${run.script.body}\n})()`;
			run.interrupted = false;
			run.interruptTicks = 0;
			run.sliceStartedAt = ambient.now();
			run.sliceLive = run.mode !== "restart";
			run.userCodeActive = true;
			let result: ReturnType<QuickJSContext["evalCode"]>;
			try {
				result = run.context.evalCode(wrapper);
			} finally {
				run.userCodeActive = false;
			}
			if (run.interrupted) {
				if (result.error !== undefined) result.error.dispose();
				else result.value.dispose();
				throw new Error(
					run.memoryExceeded ? "workflow memory budget exceeded" : "workflow instruction budget exceeded",
				);
			}
			if (result.error !== undefined) {
				const reason = extractError(run.context.dump(result.error));
				result.error.dispose();
				throw new Error(reason);
			}
			run.resultPromise = result.value;
			checkMemory(run);
			enter(run, () => drive(run, run.mode !== "restart"));
		} catch (error) {
			terminalize(
				run,
				"failed",
				null,
				run.memoryExceeded
					? "workflow memory budget exceeded"
					: run.interrupted
						? "workflow instruction budget exceeded"
						: extractError(error),
			);
		}
	};

	const beginRun = (record: WorkflowRunRecord, mode: RunState["mode"], resumeSource?: ResumeSource): boolean => {
		if (stopped || active.has(record.runId)) return false;
		let script: WorkflowScript;
		try {
			script = extractWorkflowScript(record.script);
		} catch (error) {
			if (runner.transition(record.runId, "running", "failed", { failureReason: extractError(error) })) {
				deps.onChanged?.(record.team);
			}
			return false;
		}
		const state = createRunState(record, script, mode, resumeSource);
		active.set(record.runId, state);
		void prepare(state);
		return true;
	};

	const rowsFor = (runId: string): WorkflowJournalRow[] => runner.rows(runId);

	return {
		start() {
			if (started || stopped) return false;
			if (!runner.start()) return false;
			started = true;
			for (const record of runner.running()) beginRun(record, "restart", { record, rows: rowsFor(record.runId) });
			for (const record of runner.running()) deps.onChanged?.(record.team);
			return true;
		},
		startRun(input) {
			if (stopped) return { kind: "refused", reason: "stopped" };
			const parsed = WorkflowStartInputSchema.safeParse(input);
			if (!parsed.success) return { kind: "refused", reason: "storage" };
			const existing = runner.existingStart(parsed.data.operationId);
			if (existing) return { kind: "existing", run: existing };
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
			const result = runner.startRun({ ...parsed.data, phases: script.phases });
			if (result.kind === "started") {
				deps.onChanged?.(result.run.team);
				beginRun(result.run, resumeSource ? "resume" : "live", resumeSource);
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
			return record?.status === "running"
				? beginRun(record, "restart", { record, rows: rowsFor(record.runId) })
				: false;
		},
		tick() {
			if (stopped) return;
			dispatch.tick?.();
			for (const record of runner.running()) {
				const run = active.get(record.runId);
				if (run) enter(run, () => drive(run, run.mode !== "restart"));
				else beginRun(record, "restart", { record, rows: rowsFor(record.runId) });
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
			dispatch.stop?.();
			for (const run of active.values()) disposeRun(run);
			active.clear();
		},
	};
}
