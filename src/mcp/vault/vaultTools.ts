import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	MAX_VAULT_CAPTURE_CHARS,
	VAULT_OPERATION_MAX,
	VAULT_ROUTE_WAIT_CAP_MS,
	VaultValueAnswerSchema,
} from "../../shared/schemasVault.js";
import type { RidingAwareness } from "../../shared/types.js";
import { emitLocalAwareness, routerPost } from "../bridge/helpers.js";
import { DEFAULT_ENV_NAME, FILE_ENV_NAME, runWithValue, type VaultRunHandle, type VaultRunResult } from "./vaultRun.js";

////////////////////////////////
//  Schemas

const CaptureSchema = z.object({
	publicTitle: z.string().min(1).max(256).describe(`The new entry's title, public.`),
	publicDescription: z.string().max(2048).optional().describe(`Public description.`),
});

const SearchInputSchema = {
	query: z.string().max(256).optional().describe(`Substring of the public title or description. Omit for all.`),
};

const RunInputSchema = {
	command: z
		.string()
		.min(1)
		.max(VAULT_OPERATION_MAX)
		.describe(
			`Shell line, run with \`sh -c\`, at most ${VAULT_OPERATION_MAX} characters. The owner reads it before approving.`,
		),
	cwd: z
		.string()
		.max(4096)
		.optional()
		.describe(`Working directory. Default: the MCP process's, not the project root.`),
	entryId: z.string().min(1).max(64).optional().describe(`Entry whose value to inject. Omit for a capture-only run.`),
	shape: z
		.enum(["env", "stdin", "file"])
		.optional()
		.describe(
			`
\`env\`: the value in \`$${DEFAULT_ENV_NAME}\` (default), or \`envName\`.
\`stdin\`: the value followed by a newline on stdin.
\`file\`: a 0600 file holding the value, its path in \`$${FILE_ENV_NAME}\`, gone after exit.
`.trim(),
		),
	envName: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.max(64)
		.optional()
		.describe(`Variable name for the \`env\` shape only; ignored by the others.`),
	capture: CaptureSchema.optional().describe(
		`
Store stdout as a new entry the owner can edit; stdout is then never returned. \`captured\` is its id, or null with a reason when empty, oversized or refused.

With no \`entryId\` the command runs at once: the road for generating a secret.
`.trim(),
	),
};

const CollectInputSchema = {
	jobId: z.string().min(1).max(128).describe(`From \`vault_run\`.`),
};

const WithdrawInputSchema = {
	jobId: z.string().min(1).max(128).describe(`The job to give up.`),
};

////////////////////////////////
//  Interfaces & Types

export type VaultPost = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export interface VaultToolDeps {
	post: VaultPost;
	run: typeof runWithValue;
	now: () => number;
	/** Wakes the session. */
	notify: (awareness: RidingAwareness, stillWanted: () => boolean) => void;
	/** Delay between retries. */
	retryMs?: number;
}

interface RunSpec {
	command: string;
	cwd?: string;
	shape: "env" | "stdin" | "file";
	envName?: string;
	capture?: z.infer<typeof CaptureSchema>;
}

type Job =
	| { kind: "awaiting"; spec: RunSpec; requestId: string; deadlineAt: number }
	| { kind: "running"; spec: RunSpec; handle: VaultRunHandle; exited: boolean }
	| { kind: "settled"; answer: VaultToolAnswer };

export type VaultToolAnswer = Record<string, unknown>;

////////////////////////////////
//  Functions & Helpers

const SEARCH_DESCRIPTION = `
# Vault Search

List the owner's vault entries this session may use: id, public title, public description, and whether a value is held.

No tool answers a value. Use the id with \`vault_run\`.
`.trim();

const RUN_DESCRIPTION = `
# Vault Run

Run a shell command with a vault entry's value injected, once the owner approves it on the phone.

The owner reads the command. Name the real program and target: \`ssh deploy@prod\`, not \`sh script.sh\`. Never expand the value onto a command line: \`ps\` shows argv.

For a sudo password, skip this tool: run commands individually as \`sudo -A <command>\`, without a wrapper (like \`-c\` or a script).

Answers at once with a \`jobId\` and \`pending\` (the owner has not answered) or \`running\`. A notice naming \`vault_collect\` follows when the job settles. A pre-job refusal returns \`refused\` with its reason and any owner note.

A repeated \`vault_run\` with the same entry and command joins the request still open.
`.trim();

const COLLECT_DESCRIPTION = `
# Vault Collect

Returns \`pending\` or \`running\` at once. A settled job answers once, then is gone:
- \`ran\`: exit code or signal, stdout and stderr with the value replaced by \`[vault]\`.
- \`refused\`: declined, expired, or not allowed. Follow any owner note.
`.trim();

const WITHDRAW_DESCRIPTION = `
# Vault Withdraw

Give up a job: a pending request is withdrawn from the owner's phone, a running command is stopped. \`withdrawn: false\` with a reason means the request may still be live; retry, or let it expire.
`.trim();

const RETRY_MS = 2_000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** routerPost throws a non-2xx as its body text; a route's own refusal reads through it. */
function refusalOf(error: unknown, action: string): VaultToolAnswer {
	const message = errorText(error);
	const body = /^HTTP \d+: ([\s\S]*)$/.exec(message)?.[1] ?? message;
	try {
		const parsed = JSON.parse(body) as unknown;
		const answer = VaultValueAnswerSchema.safeParse(parsed);
		if (answer.success && answer.data.outcome === "refused")
			return {
				outcome: "refused",
				reason: answer.data.reason,
				...(answer.data.note ? { note: answer.data.note } : {}),
			};
		const gateway = (parsed as { error?: unknown } | null)?.error;
		if (typeof gateway === "string") return { outcome: "refused", reason: `${action}: ${gateway}` };
	} catch {}
	return { outcome: "refused", reason: `${action}: ${message}` };
}

async function finish(spec: RunSpec, result: VaultRunResult, deps: VaultToolDeps): Promise<VaultToolAnswer> {
	const truncated = result.stdoutCut || result.stderrCut || result.stdoutCapped || result.stderrCapped;
	const base = {
		outcome: "ran",
		exitCode: result.exitCode,
		...(result.signal ? { signal: result.signal } : {}),
		stderr: result.stderr,
		...(truncated ? { truncated: true } : {}),
	};
	if (!spec.capture) return { ...base, stdout: result.stdout };
	// A cut stdout would store a piece of the secret as the whole of it; a noisy stderr would not.
	if (result.stdoutCut) return { ...base, captured: null, reason: "stdout was cut, so nothing was stored" };
	const raw = result.rawStdout();
	// The gateway trims one trailing newline; the value is judged as it will be stored.
	const stored = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	if (!stored) return { ...base, captured: null, reason: "the command wrote nothing to stdout" };
	if (stored.length > MAX_VAULT_CAPTURE_CHARS)
		return { ...base, captured: null, reason: `stdout exceeds ${MAX_VAULT_CAPTURE_CHARS} characters` };
	try {
		const created = (await deps.post("/vault/capture", { ...spec.capture, value: raw })) as { id?: string };
		return { ...base, captured: created.id ?? null };
	} catch (error) {
		return { ...base, captured: null, reason: refusalOf(error, "capture").reason };
	}
}

/** 4xx responses are final. */
function answered(error: unknown): boolean {
	return /^HTTP 4\d\d:/.test(errorText(error));
}

export function createVaultTools(deps: VaultToolDeps) {
	const jobs = new Map<string, Job>();
	const retryMs = deps.retryMs ?? RETRY_MS;
	let closed = false;

	function settleJob(jobId: string, answer: VaultToolAnswer): void {
		if (closed || !jobs.has(jobId)) return;
		jobs.set(jobId, { kind: "settled", answer });
		deps.notify(
			{
				from: "vault",
				body: `Vault job ${jobId} ${String(answer.outcome)}. Call vault_collect with jobId ${jobId}.`,
				act: "act_now",
			},
			() => jobs.get(jobId)?.kind === "settled",
		);
	}

	/** A launch that throws settles the job refused. */
	function start(jobId: string, spec: RunSpec, launch: () => VaultRunHandle): void {
		let handle: VaultRunHandle;
		try {
			handle = launch();
		} catch (error) {
			jobs.set(jobId, { kind: "awaiting", spec, requestId: "", deadlineAt: deps.now() });
			settleJob(jobId, { outcome: "refused", reason: `the command could not start: ${errorText(error)}` });
			return;
		}
		const job: Job = { kind: "running", spec, handle, exited: false };
		jobs.set(jobId, job);
		void handle.done
			.then((result) => {
				job.exited = true;
				return jobs.get(jobId) === job ? finish(spec, result, deps) : null;
			})
			.then((answer) => {
				if (answer && jobs.get(jobId) === job) settleJob(jobId, answer);
			});
	}

	function apply(jobId: string, spec: RunSpec, answer: unknown): "waiting" | "done" {
		const parsed = VaultValueAnswerSchema.safeParse(answer);
		if (!parsed.success) {
			settleJob(jobId, { outcome: "refused", reason: "the gateway answered in an unrecognized shape" });
			return "done";
		}
		if (parsed.data.outcome === "pending") return "waiting";
		if (parsed.data.outcome === "refused") {
			settleJob(jobId, {
				outcome: "refused",
				reason: parsed.data.reason,
				...(parsed.data.note ? { note: parsed.data.note } : {}),
			});
			return "done";
		}
		const approved = parsed.data;
		start(jobId, spec, () => deps.run({ ...spec, value: approved.value }));
		return "done";
	}

	async function awaitOwner(jobId: string, spec: RunSpec, requestId: string): Promise<void> {
		while (!closed && jobs.get(jobId)?.kind === "awaiting") {
			let answer: unknown;
			try {
				answer = await deps.post("/vault/collect", { requestId, waitMs: VAULT_ROUTE_WAIT_CAP_MS });
			} catch (error) {
				if (jobs.get(jobId)?.kind !== "awaiting") return;
				if (answered(error)) {
					settleJob(jobId, refusalOf(error, "collect"));
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, retryMs));
				continue;
			}
			if (jobs.get(jobId)?.kind !== "awaiting") return;
			if (apply(jobId, spec, answer) === "done") return;
		}
	}

	/** One local job per Gateway request, so one approval starts one child. */
	function jobOfRequest(requestId: string): string | undefined {
		for (const [jobId, job] of jobs) if (job.kind === "awaiting" && job.requestId === requestId) return jobId;
		return undefined;
	}

	function pendingAnswer(jobId: string): VaultToolAnswer {
		const job = jobs.get(jobId);
		if (job?.kind === "awaiting") return { outcome: "pending", jobId, deadlineAt: job.deadlineAt };
		return { outcome: "running", jobId };
	}

	return {
		async search(args: { query?: string }): Promise<VaultToolAnswer> {
			try {
				return (await deps.post(
					"/vault/search",
					args.query === undefined ? {} : { query: args.query },
				)) as VaultToolAnswer;
			} catch (error) {
				return refusalOf(error, "search");
			}
		},

		async run(args: {
			command: string;
			cwd?: string;
			entryId?: string;
			shape?: "env" | "stdin" | "file";
			envName?: string;
			capture?: z.infer<typeof CaptureSchema>;
		}): Promise<VaultToolAnswer> {
			const spec: RunSpec = {
				command: args.command,
				...(args.cwd === undefined ? {} : { cwd: args.cwd }),
				shape: args.shape ?? "env",
				...(args.envName === undefined ? {} : { envName: args.envName }),
				...(args.capture === undefined ? {} : { capture: args.capture }),
			};
			const jobId = crypto.randomUUID();
			if (!args.entryId) {
				if (!spec.capture) return { outcome: "refused", reason: "name an entryId, or capture" };
				start(jobId, spec, () => deps.run(spec));
				return pendingAnswer(jobId);
			}
			let answer: unknown;
			try {
				answer = await deps.post("/vault/use", { entryId: args.entryId, operation: args.command, waitMs: 0 });
			} catch (error) {
				return refusalOf(error, "use");
			}
			const parsed = VaultValueAnswerSchema.safeParse(answer);
			if (!parsed.success) return { outcome: "refused", reason: "the gateway answered in an unrecognized shape" };
			if (closed) {
				if (parsed.data.outcome === "pending") {
					await deps.post("/vault/withdraw", { requestId: parsed.data.requestId }).catch(() => undefined);
				}
				return { outcome: "refused", reason: "the session is shutting down" };
			}
			if (parsed.data.outcome === "refused") {
				return {
					outcome: "refused",
					reason: parsed.data.reason,
					...(parsed.data.note ? { note: parsed.data.note } : {}),
				};
			}
			if (parsed.data.outcome === "pending") {
				const { requestId, deadlineAt } = parsed.data;
				const joined = jobOfRequest(requestId);
				if (joined) return pendingAnswer(joined);
				jobs.set(jobId, { kind: "awaiting", spec, requestId, deadlineAt });
				void awaitOwner(jobId, spec, requestId).catch((error) =>
					settleJob(jobId, { outcome: "refused", reason: `collect: ${errorText(error)}` }),
				);
			} else {
				const approved = parsed.data;
				start(jobId, spec, () => deps.run({ ...spec, value: approved.value }));
			}
			return pendingAnswer(jobId);
		},

		async collect(args: { jobId: string }): Promise<VaultToolAnswer> {
			const job = jobs.get(args.jobId);
			if (!job) return { outcome: "refused", reason: "no such job" };
			if (job.kind !== "settled") return pendingAnswer(args.jobId);
			jobs.delete(args.jobId);
			return job.answer;
		},

		async withdraw(args: { jobId: string }): Promise<VaultToolAnswer> {
			const job = jobs.get(args.jobId);
			if (!job) return { withdrawn: false, reason: "no such job" };
			if (job.kind === "settled") {
				jobs.delete(args.jobId);
				return { withdrawn: false, reason: "the job had already settled" };
			}
			if (job.kind === "running") {
				if (job.exited) return { withdrawn: false, reason: "the command already exited" };
				jobs.delete(args.jobId);
				job.handle.kill();
				await job.handle.done;
				return { withdrawn: true };
			}
			let answer: { withdrawn?: boolean };
			try {
				answer = (await deps.post("/vault/withdraw", { requestId: job.requestId })) as { withdrawn?: boolean };
			} catch (error) {
				// The request may still be live; the job stays for another try.
				return { withdrawn: false, reason: refusalOf(error, "withdraw").reason };
			}
			if (!answer.withdrawn) return { withdrawn: false, reason: "the request had already settled" };
			jobs.delete(args.jobId);
			return { withdrawn: true };
		},

		/** Children are stopped before anything is awaited. */
		async shutdown(): Promise<void> {
			closed = true;
			const held = [...jobs.values()];
			jobs.clear();
			const stopped = held
				.filter((job) => job.kind === "running")
				.map((job) => {
					job.handle.kill();
					return job.handle.done;
				});
			const withdrawn = held
				.filter((job) => job.kind === "awaiting")
				.map((job) => deps.post("/vault/withdraw", { requestId: job.requestId }));
			await Promise.allSettled([...stopped, ...withdrawn]);
		},
	};
}

function text(answer: VaultToolAnswer): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(answer, null, 2) }] };
}

const postOnce: VaultPost = (path, body) => routerPost(path, body, { retries: 0 });

////////////////////////////////
//  Registration

export function registerVaultTools(
	mcpServer: McpServer,
	deps: VaultToolDeps = {
		post: postOnce,
		run: runWithValue,
		now: () => Date.now(),
		notify: (awareness, stillWanted) => {
			void emitLocalAwareness(awareness, stillWanted).catch((error) =>
				console.error("[vault] notice failed:", error),
			);
		},
	},
): ReturnType<typeof createVaultTools> {
	const tools = createVaultTools(deps);
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const searchSchema: any = SearchInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const runSchema: any = RunInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const collectSchema: any = CollectInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const withdrawSchema: any = WithdrawInputSchema;

	mcpServer.registerTool(
		"vault_search",
		{ title: `Vault Search`, description: SEARCH_DESCRIPTION, inputSchema: searchSchema },
		async (args: { query?: string }) => text(await tools.search(args)),
	);
	mcpServer.registerTool(
		"vault_run",
		{ title: `Vault Run`, description: RUN_DESCRIPTION, inputSchema: runSchema },
		async (args: Parameters<typeof tools.run>[0]) => text(await tools.run(args)),
	);
	mcpServer.registerTool(
		"vault_collect",
		{ title: `Vault Collect`, description: COLLECT_DESCRIPTION, inputSchema: collectSchema },
		async (args: { jobId: string }) => text(await tools.collect(args)),
	);
	mcpServer.registerTool(
		"vault_withdraw",
		{ title: `Vault Withdraw`, description: WITHDRAW_DESCRIPTION, inputSchema: withdrawSchema },
		async (args: { jobId: string }) => text(await tools.withdraw(args)),
	);
	return tools;
}
