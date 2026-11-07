// QuickJS VM ownership.

import fs from "node:fs";
import { createRequire } from "node:module";
import syncVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten-core";
import type { Ambient } from "../../shared/ambient.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { WORKFLOW_PRELUDE } from "./prelude.js";
import { type WorkflowScript, WorkflowScriptError } from "./script.js";
import { type JsonValue, JsonValueSchema } from "./workflowSchemas.js";

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MEMORY_CHECK_LIMIT_BYTES = 24 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const JOB_BATCH_LIMIT = 256;
const JOB_SLICE_LIMIT = 8192;
const INTERRUPT_TICK_LIMIT = 512;
const LIVE_SLICE_MS = 200;

const require = createRequire(import.meta.url);
const wasmBytes = fs.readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"));
const wasmBinary = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
const compiledWasm = WebAssembly.compile(wasmBinary);
const quickJsVariant = newVariant(syncVariant, { wasmModule: compiledWasm, wasmBinary });

////////////////////////////////
//  Interfaces & Types

export type WorkflowQuickJSModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

export type WorkflowVmBudget = "memory" | "instructions" | "jobs";

/** Budget null: a guest error. */
export class WorkflowVmError extends Error {
	constructor(
		readonly budget: WorkflowVmBudget | null,
		message: string,
	) {
		super(message);
		this.name = "WorkflowVmError";
	}
}

export interface WorkflowVmHost {
	/** Answers the settle key; a throw reaches the script. */
	issue(prompt: string, options: unknown): number;
	log(text: string): void;
	phase(title: string): void;
}

export type WorkflowVmResult =
	| { type: "pending" }
	| { type: "fulfilled"; value: unknown }
	| { type: "rejected"; reason: string };

export interface WorkflowVm {
	boot(script: WorkflowScript, args: JsonValue, host: WorkflowVmHost, live: boolean): void;
	drain(live: boolean): void;
	settle(key: number, answer: JsonValue): void;
	result(): WorkflowVmResult;
	/** Defers disposal until unwind. */
	dispose(): void;
}

export interface WorkflowScriptValidator {
	load(): Promise<void>;
	ready(): boolean;
	validate(script: WorkflowScript): void;
	stop(): void;
}

////////////////////////////////
//  Functions & Helpers

const BUDGET_MESSAGES: Record<WorkflowVmBudget, string> = {
	memory: "workflow memory budget exceeded",
	instructions: "workflow instruction budget exceeded",
	jobs: "workflow job budget exceeded",
};

const budgetError = (budget: WorkflowVmBudget) => new WorkflowVmError(budget, BUDGET_MESSAGES[budget]);

/** Loads one run module. */
export const loadQuickJSModule = (): Promise<WorkflowQuickJSModule> => newQuickJSWASMModuleFromVariant(quickJsVariant);

const workflowWrapper = (script: WorkflowScript): string => `(async () => {\n${script.body}\n})()`;

/** Caller disposes the handle. */
function errorText(context: QuickJSContext, error: QuickJSHandle): string {
	try {
		const value: unknown = context.dump(error);
		if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
			return (value as { message: string }).message;
		}
		if (typeof value === "string") return value;
		return JSON.stringify(value) ?? "workflow failed";
	} catch {
		return "workflow failed";
	}
}

function boundedRuntime(module: WorkflowQuickJSModule, interruptHandler?: () => boolean): QuickJSRuntime {
	const runtime = module.newRuntime({
		memoryLimitBytes: MEMORY_LIMIT_BYTES,
		maxStackSizeBytes: STACK_LIMIT_BYTES,
		...(interruptHandler ? { interruptHandler } : {}),
	});
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	return runtime;
}

/** Unreadable counts as over. */
function memoryUsed(runtime: QuickJSRuntime, context: QuickJSContext): number {
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
}

function evalOrThrow(context: QuickJSContext, code: string): void {
	const result = context.evalCode(code);
	if (result.error !== undefined) {
		const reason = errorText(context, result.error);
		result.error.dispose();
		throw new WorkflowVmError(null, reason);
	}
	result.value.dispose();
}

/** Attaches frozen guest JSON. */
function attachJson(context: QuickJSContext, name: string, value: JsonValue): void {
	const literal = JSON.stringify(JSON.stringify(value));
	evalOrThrow(
		context,
		`globalThis.${name} = (() => { const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) freeze(value[key]); } return value; }; return freeze(JSON.parse(${literal})); })();`,
	);
}

/** Evaluates host-free meta. */
function checkMeta(runtime: QuickJSRuntime, script: WorkflowScript): void {
	const context = runtime.newContext();
	try {
		const result = context.evalCode(`const meta = JSON.parse(${JSON.stringify(script.metaLiteral)}); meta`);
		if (result.error !== undefined) {
			const reason = errorText(context, result.error);
			result.error.dispose();
			throw new WorkflowVmError(null, reason);
		}
		const parsed = JsonValueSchema.parse(context.dump(result.value));
		result.value.dispose();
		if (canonicalJson(parsed) !== canonicalJson(script.meta)) {
			throw new WorkflowVmError(null, "meta did not evaluate as JSON");
		}
	} finally {
		context.dispose();
	}
}

function validateScript(module: WorkflowQuickJSModule, script: WorkflowScript): void {
	let runtime: QuickJSRuntime | undefined;
	let context: QuickJSContext | undefined;
	let result: ReturnType<QuickJSContext["evalCode"]> | undefined;
	try {
		runtime = boundedRuntime(module);
		context = runtime.newContext();
		result = context.evalCode(workflowWrapper(script), undefined, { compileOnly: true });
		if (result.error !== undefined) throw new WorkflowScriptError("syntax", errorText(context, result.error));
	} finally {
		try {
			if (result?.error !== undefined) result.error.dispose();
			else result?.value.dispose();
		} catch {}
		try {
			context?.dispose();
		} catch {}
		try {
			runtime?.dispose();
		} catch {}
	}
}

export function createQuickJSScriptValidator(
	moduleLoader: () => Promise<WorkflowQuickJSModule> = loadQuickJSModule,
): WorkflowScriptValidator {
	let module: WorkflowQuickJSModule | undefined;
	let loading: Promise<void> | undefined;
	let stopped = false;
	return {
		load() {
			if (module) return Promise.resolve();
			if (loading) return loading;
			const current = moduleLoader().then((loaded) => {
				if (!stopped) module = loaded;
			});
			let tracked: Promise<void>;
			tracked = current.catch((error) => {
				if (loading === tracked) loading = undefined;
				throw error;
			});
			loading = tracked;
			return tracked;
		},
		ready: () => module !== undefined,
		validate(script) {
			if (!module) throw new Error("workflow validator is not ready");
			validateScript(module, script);
		},
		stop() {
			stopped = true;
			module = undefined;
		},
	};
}

export async function createWorkflowVm(deps: { ambient: Pick<Ambient, "now"> }): Promise<WorkflowVm> {
	const module = await loadQuickJSModule();
	return workflowVmOf(module, deps.ambient);
}

function workflowVmOf(module: WorkflowQuickJSModule, ambient: Pick<Ambient, "now">): WorkflowVm {
	let runtime: QuickJSRuntime | undefined;
	let context: QuickJSContext | undefined;
	let resultPromise: QuickJSHandle | undefined;
	const deferreds = new Map<number, QuickJSDeferredPromise>();
	let userCodeActive = false;
	let interrupted: WorkflowVmBudget | null = null;
	let interruptTicks = 0;
	let sliceStartedAt = 0;
	let sliceLive = true;
	let disposed = false;
	let disposePending = false;
	let depth = 0;

	const release = (): void => {
		disposePending = false;
		for (const deferred of deferreds.values()) {
			try {
				if (deferred.alive) deferred.dispose();
			} catch {}
		}
		deferreds.clear();
		try {
			resultPromise?.dispose();
		} catch {}
		try {
			context?.dispose();
		} catch {}
		try {
			runtime?.dispose();
		} catch {}
		resultPromise = undefined;
		context = undefined;
		runtime = undefined;
	};

	/** Defers disposal until unwind. */
	const guarded = <T>(work: () => T): T => {
		depth += 1;
		try {
			return work();
		} finally {
			depth -= 1;
			if (depth === 0 && disposePending) release();
		}
	};

	const interrupt = (): boolean => {
		if (!userCodeActive) return false;
		interruptTicks += 1;
		if (interruptTicks % 2 === 0 && runtime && context && memoryUsed(runtime, context) > MEMORY_CHECK_LIMIT_BYTES) {
			interrupted = "memory";
			return true;
		}
		if (interruptTicks > INTERRUPT_TICK_LIMIT || (sliceLive && ambient.now() - sliceStartedAt > LIVE_SLICE_MS)) {
			interrupted = "instructions";
			return true;
		}
		return false;
	};

	const beginSlice = (live: boolean): void => {
		interrupted = null;
		interruptTicks = 0;
		sliceStartedAt = ambient.now();
		sliceLive = live;
	};

	const checkMemory = (): void => {
		if (runtime && context && memoryUsed(runtime, context) > MEMORY_CHECK_LIMIT_BYTES) throw budgetError("memory");
	};

	const asGuest = <T>(work: () => T): T => {
		userCodeActive = true;
		try {
			return work();
		} finally {
			userCodeActive = false;
		}
	};

	const installHost = (ctx: QuickJSContext, host: WorkflowVmHost): void => {
		const define = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
			const handle = ctx.newFunction(name, (...args) => fn(...args));
			ctx.setProp(ctx.global, name, handle);
			handle.dispose();
		};
		define("agent", (prompt, options) => {
			if (prompt === undefined || ctx.typeof(prompt) !== "string")
				throw new Error("agent prompt must be a string");
			// A refused issue leaves no stray promise.
			const deferred = ctx.newPromise();
			let key: number;
			try {
				key = host.issue(ctx.getString(prompt), options === undefined ? {} : ctx.dump(options));
			} catch (error) {
				deferred.dispose();
				throw error;
			}
			deferreds.set(key, deferred);
			return deferred.handle;
		});
		define("log", (value) => {
			let rendered: string;
			try {
				const dumped: unknown = value === undefined ? undefined : ctx.dump(value);
				rendered = typeof dumped === "string" ? dumped : (JSON.stringify(dumped) ?? String(dumped));
			} catch {
				rendered = "[unserializable]";
			}
			host.log(rendered);
			return ctx.undefined;
		});
		define("phase", (name) => {
			if (name === undefined || ctx.typeof(name) !== "string") throw new Error("phase needs a title");
			host.phase(ctx.getString(name));
			return ctx.undefined;
		});
	};

	return {
		boot(script, args, host, live) {
			guarded(() => {
				if (disposed) throw new WorkflowVmError(null, "workflow VM is disposed");
				if (runtime) throw new WorkflowVmError(null, "workflow VM already booted");
				runtime = boundedRuntime(module, interrupt);
				checkMeta(runtime, script);
				const ctx = runtime.newContext();
				context = ctx;
				installHost(ctx, host);
				beginSlice(live);
				evalOrThrow(ctx, WORKFLOW_PRELUDE);
				attachJson(ctx, "args", args);
				attachJson(ctx, "meta", script.meta);
				beginSlice(live);
				const result = asGuest(() => ctx.evalCode(workflowWrapper(script)));
				if (interrupted) {
					if (result.error !== undefined) result.error.dispose();
					else result.value.dispose();
					throw budgetError(interrupted);
				}
				if (result.error !== undefined) {
					const reason = errorText(ctx, result.error);
					result.error.dispose();
					throw new WorkflowVmError(null, reason);
				}
				resultPromise = result.value;
				checkMemory();
			});
		},
		drain(live) {
			guarded(() => {
				const rt = runtime;
				const ctx = context;
				if (disposed || !rt || !ctx) return;
				beginSlice(live);
				let jobs = 0;
				asGuest(() => {
					while (!disposed && rt.hasPendingJob() && jobs < JOB_SLICE_LIMIT) {
						const result = rt.executePendingJobs(JOB_BATCH_LIMIT);
						if (result.error !== undefined) {
							const reason = errorText(ctx, result.error);
							result.dispose();
							if (interrupted) throw budgetError(interrupted);
							throw new WorkflowVmError(null, reason);
						}
						const executed = result.value;
						jobs += executed;
						result.dispose();
						if (interrupted) throw budgetError(interrupted);
						checkMemory();
						if (executed === 0) break;
						if (jobs >= JOB_SLICE_LIMIT && rt.hasPendingJob()) throw budgetError("jobs");
					}
				});
			});
		},
		settle(key, answer) {
			guarded(() => {
				const deferred = deferreds.get(key);
				if (!deferred) return;
				deferreds.delete(key);
				let handle: QuickJSHandle | undefined;
				try {
					if (disposed || !context || !deferred.alive) return;
					const evaluated = context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(answer))})`);
					if (evaluated.error !== undefined) {
						evaluated.error.dispose();
						return;
					}
					handle = evaluated.value;
					deferred.resolve(handle);
				} finally {
					try {
						handle?.dispose();
					} catch {}
					try {
						if (deferred.alive) deferred.dispose();
					} catch {}
				}
			});
		},
		result() {
			return guarded((): WorkflowVmResult => {
				const ctx = context;
				if (disposed || !ctx || !resultPromise) return { type: "pending" };
				const state = ctx.getPromiseState(resultPromise);
				if (state.type === "fulfilled") {
					const value: unknown = ctx.dump(state.value);
					state.value.dispose();
					return { type: "fulfilled", value };
				}
				if (state.type === "rejected") {
					const reason = errorText(ctx, state.error);
					state.error.dispose();
					return { type: "rejected", reason };
				}
				return { type: "pending" };
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (depth > 0) {
				disposePending = true;
				return;
			}
			release();
		},
	};
}
