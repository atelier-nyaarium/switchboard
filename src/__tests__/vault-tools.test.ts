import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GATED_CAPABILITY_IDS } from "../mcp/capabilities.js";
import { renderCapabilities } from "../mcp/capabilitiesTool.js";
import {
	FILE_ENV_NAME,
	runWithValue,
	scrubOutput,
	type VaultRunHandle,
	type VaultRunResult,
	WITHHELD,
} from "../mcp/vault/vaultRun.js";
import { createVaultTools, type VaultPost, type VaultToolAnswer } from "../mcp/vault/vaultTools.js";
import { VAULT_ROUTE_WAIT_CAP_MS } from "../shared/schemasVault.js";

const SECRET = "s3cr3t-value";

/** Answers each path from a queue, and records what was posted. */
function fakeGateway(answers: Record<string, unknown[]>) {
	const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
	const postWaiters: Array<{ path: string; count: number; resolve: () => void }> = [];
	const post: VaultPost = async (path, body) => {
		posted.push({ path, body });
		for (const waiter of [...postWaiters]) {
			if (waiter.path === path && posted.filter((item) => item.path === path).length >= waiter.count) {
				postWaiters.splice(postWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
		const queue = answers[path] ?? [];
		if (queue.length === 0) throw new Error(`no answer queued for ${path}`);
		const next = queue.shift();
		if (next instanceof Error) throw next;
		return next;
	};
	const waitForPost = (path: string, count = 1) =>
		posted.filter((item) => item.path === path).length >= count
			? Promise.resolve()
			: new Promise<void>((resolve) => postWaiters.push({ path, count, resolve }));
	return { post, posted, waitForPost };
}

/** A child the test ends by hand. */
function fakeRun() {
	const handles: Array<{ resolve: (result: VaultRunResult) => void; killed: boolean }> = [];
	const startWaiters: Array<{ index: number; resolve: (slot: (typeof handles)[number]) => void }> = [];
	const run: typeof runWithValue = () => {
		const slot: { resolve: (result: VaultRunResult) => void; killed: boolean } = {
			resolve: () => undefined,
			killed: false,
		};
		const done = new Promise<VaultRunResult>((resolve) => {
			slot.resolve = resolve;
		});
		handles.push(slot);
		for (const waiter of [...startWaiters]) {
			if (handles.length > waiter.index) {
				startWaiters.splice(startWaiters.indexOf(waiter), 1);
				waiter.resolve(handles[waiter.index]);
			}
		}
		const handle: VaultRunHandle = {
			done,
			kill: () => {
				slot.killed = true;
				slot.resolve(exited("", { signal: "SIGTERM" }));
			},
		};
		return handle;
	};
	const waitForStart = (index = 0) =>
		handles[index]
			? Promise.resolve(handles[index])
			: new Promise<(typeof handles)[number]>((resolve) => startWaiters.push({ index, resolve }));
	return { run, handles, waitForStart };
}

const tools = (
	answers: Record<string, unknown[]>,
	run: typeof runWithValue = runWithValue,
	options: { retryMs?: number } = {},
) => {
	const gateway = fakeGateway(answers);
	const notifications: Array<{ awareness: unknown; stillWanted: () => boolean }> = [];
	const notificationQueue: Array<{ awareness: unknown; stillWanted: () => boolean }> = [];
	const notificationWaiters: Array<(notice: (typeof notifications)[number]) => void> = [];
	const notify = (awareness: unknown, stillWanted: () => boolean) => {
		const notice = { awareness, stillWanted };
		notifications.push(notice);
		const waiter = notificationWaiters.shift();
		if (waiter) waiter(notice);
		else notificationQueue.push(notice);
	};
	const nextNotice = () => {
		const notice = notificationQueue.shift();
		return notice
			? Promise.resolve(notice)
			: new Promise<(typeof notifications)[number]>((resolve) => notificationWaiters.push(resolve));
	};
	return {
		...gateway,
		notifications,
		nextNotice,
		tools: createVaultTools({ post: gateway.post, run, now: () => Date.now(), notify, ...options }),
	};
};

async function collectAfterNotice(t: ReturnType<typeof tools>, started: VaultToolAnswer): Promise<VaultToolAnswer> {
	await t.nextNotice();
	return t.tools.collect({ jobId: String(started.jobId) });
}

type VaultRunArgs = Parameters<ReturnType<typeof createVaultTools>["run"]>[0];

async function runAndCollect(t: ReturnType<typeof tools>, args: VaultRunArgs): Promise<VaultToolAnswer> {
	const started = await t.tools.run(args);
	return typeof started.jobId === "string" ? collectAfterNotice(t, started) : started;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
const approved = { outcome: "approved", decision: "once", value: SECRET };
const pending = (requestId: string) => ({ outcome: "pending", requestId, deadlineAt: 9_000 });
const httpError = (status: number, body: unknown) => new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
const exited = (stdout: string, over: Partial<VaultRunResult> = {}): VaultRunResult => ({
	exitCode: 0,
	signal: null,
	stdout,
	stderr: "",
	stdoutCut: false,
	stderrCut: false,
	stdoutCapped: false,
	stderrCapped: false,
	rawStdout: () => stdout,
	...over,
});

describe("the child run", () => {
	it("injects by env, stdin, and file, scrubs the value from both streams, and unlinks the file", async () => {
		const env = await runWithValue({
			command: 'echo "got $VAULT_VALUE"; echo "$VAULT_VALUE" >&2',
			shape: "env",
			value: SECRET,
		}).done;
		expect(env).toMatchObject({ exitCode: 0, stdout: "got [vault]\n", stderr: "[vault]\n" });

		const named = await runWithValue({ command: 'printf %s "$PW"', shape: "env", envName: "PW", value: SECRET })
			.done;
		expect(named.stdout).toBe("[vault]");

		const stdin = await runWithValue({
			command: "IFS= read -r line; printf '<%s>' \"$line\"",
			shape: "stdin",
			value: SECRET,
		}).done;
		expect(stdin.stdout).toBe("<[vault]>");

		const pathFile = `${process.env.PWD}/.vault-test-path`;
		const viaFile = await runWithValue({
			command: `printf %s "$${FILE_ENV_NAME}" > "${pathFile}"; stat -c %a "$${FILE_ENV_NAME}"; cat "$${FILE_ENV_NAME}"`,
			shape: "file",
			value: SECRET,
		}).done;
		const file = fs.readFileSync(pathFile, "utf8");
		fs.rmSync(pathFile);
		expect(viaFile.stdout).toBe("600\n[vault]");
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps switchboard's own secrets out of the child's environment and reports a failed exit", async () => {
		const result = await runWithValue(
			{ command: 'printf "%s|%s" "$SWITCHBOARD_SESSION_TOKEN" "$KEEP"; exit 3', shape: "env", value: SECRET },
			{ PATH: process.env.PATH, SWITCHBOARD_SESSION_TOKEN: "tok", KEEP: "kept" },
		).done;
		expect(result).toMatchObject({ exitCode: 3, stdout: "|kept" });
	});

	it("caps the output after the scrub, so a value near a cut never leaks a piece", async () => {
		const capped = await runWithValue({ command: "head -c 100000 /dev/zero | tr '\\0' x", shape: "env" }).done;
		expect(capped).toMatchObject({ stdoutCapped: true, stdoutCut: false });
		expect(capped.stdout.length).toBe(64 * 1024);

		const straddling = await runWithValue({
			command: `head -c 1048570 /dev/zero | tr '\\0' x; printf %s "$VAULT_VALUE"; printf x`,
			shape: "env",
			value: SECRET,
		}).done;
		expect(straddling.stdoutCut).toBe(true);
		expect(straddling.stdout).not.toContain(SECRET.slice(0, 4));
		expect(straddling.rawStdout()).not.toContain(SECRET.slice(0, 4));
	});

	it("drops a multibyte value's whole byte length at a cut, and a noisy stderr is its own fact", async () => {
		const wide = "パスワード";
		const straddling = await runWithValue({
			command: `head -c 1048570 /dev/zero | tr '\\0' x; printf %s "$VAULT_VALUE"`,
			shape: "env",
			value: wide,
		}).done;
		expect(straddling.stdoutCut).toBe(true);
		expect(straddling.stdout).not.toContain(wide.slice(0, 1));

		const noisy = await runWithValue({ command: "head -c 100000 /dev/zero | tr '\\0' x >&2", shape: "env" }).done;
		expect(noisy).toMatchObject({ stderrCapped: true, stdoutCut: false, stdoutCapped: false });
	});

	it("hands the raw stdout back for a capture, without a flag to forget", async () => {
		const run = await runWithValue({ command: 'printf %s "$VAULT_VALUE-x"', shape: "env", value: SECRET }).done;
		expect(run.stdout).toBe("[vault]-x");
		expect(run.rawStdout()).toBe(`${SECRET}-x`);
	});

	it("scrubs every occurrence, with newlines and metacharacters, and leaves other text alone", () => {
		const odd = "a.b*c\nd$";
		expect(scrubOutput(`x${odd}y${odd}`, odd)).toBe("x[vault]y[vault]");
		expect(scrubOutput("plain", undefined)).toBe("plain");
	});

	it("withholds a stream whose value would survive inside the mark", async () => {
		// "au" sits inside "[vault]", so scrubbing alone would leave it readable.
		const inside = await runWithValue({ command: 'printf "x%sy" "$VAULT_VALUE"', shape: "env", value: "au" }).done;
		expect(inside.stdout).toBe(WITHHELD);
		expect(inside.rawStdout()).toBe("xauy");

		const ordinary = await runWithValue({ command: 'printf "x%sy" "$VAULT_VALUE"', shape: "env", value: SECRET })
			.done;
		expect(ordinary.stdout).toBe("x[vault]y");
	});
});

describe("the vault tools", () => {
	it("runs at once under a covering grant, and never returns the value", async () => {
		const t = tools({ "/vault/use": [approved] });
		const started = await t.tools.run({ command: 'echo "$VAULT_VALUE"', entryId: "deploy" });
		expect(started).toMatchObject({ outcome: "running", jobId: expect.any(String) });
		const ran = await collectAfterNotice(t, started);
		expect(ran).toMatchObject({ outcome: "ran", exitCode: 0, stdout: "[vault]\n" });
		expect(JSON.stringify(ran)).not.toContain(SECRET);
		expect(t.posted[0]).toEqual({
			path: "/vault/use",
			body: { entryId: "deploy", operation: 'echo "$VAULT_VALUE"', waitMs: 0 },
		});
	});

	it("a pending answer gets a local job id while background collection reaches running", async () => {
		const fake = fakeRun();
		const t = tools(
			{
				"/vault/use": [pending("req-1")],
				"/vault/collect": [pending("req-1"), approved],
			},
			fake.run,
		);
		const started = await t.tools.run({ command: 'printf %s "$VAULT_VALUE"', entryId: "deploy" });
		expect(started).toMatchObject({
			outcome: "pending",
			jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			deadlineAt: 9_000,
		});
		expect(started.jobId).not.toBe("req-1");
		await fake.waitForStart();
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toEqual({
			outcome: "running",
			jobId: started.jobId,
		});
		expect(t.posted.filter((item) => item.path === "/vault/collect")).toEqual([
			{ path: "/vault/collect", body: { requestId: "req-1", waitMs: VAULT_ROUTE_WAIT_CAP_MS } },
			{ path: "/vault/collect", body: { requestId: "req-1", waitMs: VAULT_ROUTE_WAIT_CAP_MS } },
		]);
		fake.handles[0].resolve(exited("[vault]"));
		expect(await collectAfterNotice(t, started)).toMatchObject({ outcome: "ran", stdout: "[vault]" });
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toMatchObject({ outcome: "refused" });
	});

	it("a refusal ends the job, whether it arrives as an answer or as the route's error", async () => {
		const t = tools(
			{
				"/vault/use": [
					httpError(403, { outcome: "refused", reason: "the owner did not authorize" }),
					httpError(503, { error: "vault unavailable: not enrolled" }),
					{ unexpected: true },
					pending("req-2"),
				],
				"/vault/collect": [httpError(403, { outcome: "refused", reason: "the owner did not authorize" })],
			},
			runWithValue,
			{ retryMs: 1 },
		);
		expect(await t.tools.run({ command: "true", entryId: "deploy" })).toEqual({
			outcome: "refused",
			reason: "the owner did not authorize",
		});
		const unavailable = await t.tools.run({ command: "true", entryId: "deploy" });
		expect(unavailable).toMatchObject({ outcome: "refused" });
		expect(String(unavailable.reason)).not.toContain("{");
		expect(await t.tools.run({ command: "true", entryId: "deploy" })).toEqual({
			outcome: "refused",
			reason: "the gateway answered in an unrecognized shape",
		});
		const started = await t.tools.run({ command: "true", entryId: "deploy" });
		expect(started).toMatchObject({ outcome: "pending" });
		expect(await collectAfterNotice(t, started)).toEqual({
			outcome: "refused",
			reason: "the owner did not authorize",
		});
		expect(await t.tools.withdraw({ jobId: String(started.jobId) })).toMatchObject({ withdrawn: false });
	});

	it("withdraw gives a pending request back, keeps the job when the gateway could not be asked, and stops a child", async () => {
		const fake = fakeRun();
		const t = tools(
			{
				"/vault/use": [pending("req-3"), approved],
				"/vault/withdraw": [new Error("fetch failed"), { withdrawn: true }],
			},
			fake.run,
			{ retryMs: 1 },
		);
		const pendingJob = await t.tools.run({ command: "true", entryId: "deploy" });
		expect(pendingJob).toMatchObject({ outcome: "pending" });
		expect(await t.tools.withdraw({ jobId: String(pendingJob.jobId) })).toMatchObject({
			withdrawn: false,
			reason: expect.any(String),
		});
		expect(await t.tools.withdraw({ jobId: String(pendingJob.jobId) })).toEqual({ withdrawn: true });
		expect(t.posted.filter((p) => p.path === "/vault/withdraw")).toHaveLength(2);

		const running = await t.tools.run({ command: "sleep 30", entryId: "deploy" });
		expect(running).toMatchObject({ outcome: "running", jobId: expect.any(String) });
		expect(await t.tools.withdraw({ jobId: String(running.jobId) })).toEqual({ withdrawn: true });
		expect(fake.handles[0].killed).toBe(true);
	});

	it("a running command stays collectable and its settled answer is consumed once", async () => {
		const fake = fakeRun();
		const t = tools({ "/vault/use": [approved] }, fake.run);
		const running = await t.tools.run({ command: "long", entryId: "deploy" });
		expect(running).toMatchObject({ outcome: "running", jobId: expect.any(String) });
		expect(await t.tools.collect({ jobId: String(running.jobId) })).toEqual(running);
		fake.handles[0].resolve(exited("done"));
		expect(await collectAfterNotice(t, running)).toMatchObject({
			outcome: "ran",
			stdout: "done",
		});
		expect(await t.tools.collect({ jobId: String(running.jobId) })).toMatchObject({ outcome: "refused" });
	});

	it("a job keeps its local id from pending through running", async () => {
		const fake = fakeRun();
		const t = tools({ "/vault/use": [pending("req-9")], "/vault/collect": [approved] }, fake.run);
		const started = await t.tools.run({ command: "long", entryId: "deploy" });
		expect(started).toMatchObject({ outcome: "pending", jobId: expect.any(String) });
		expect(started.jobId).not.toBe("req-9");
		await fake.waitForStart();
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toEqual({
			outcome: "running",
			jobId: started.jobId,
		});
		fake.handles[0].resolve(exited("late"));
		expect(await collectAfterNotice(t, started)).toMatchObject({ outcome: "ran", stdout: "late" });
	});

	it("collect reads immediately and approval starts the command once", async () => {
		const fake = fakeRun();
		const approval = deferred<unknown>();
		const t = tools({ "/vault/use": [pending("req-10")], "/vault/collect": [approval.promise] }, fake.run);
		const started = await t.tools.run({ command: "long", entryId: "deploy" });
		const [first, second] = await Promise.all([
			t.tools.collect({ jobId: String(started.jobId) }),
			t.tools.collect({ jobId: String(started.jobId) }),
		]);
		expect(first).toEqual({ outcome: "pending", jobId: started.jobId, deadlineAt: 9_000 });
		expect(second).toEqual(first);
		approval.resolve(approved);
		await fake.waitForStart();
		expect(fake.handles).toHaveLength(1);
		expect(t.posted.filter((p) => p.path === "/vault/collect")).toHaveLength(1);
		fake.handles[0].resolve(exited("once"));
		expect(await collectAfterNotice(t, started)).toMatchObject({ outcome: "ran", stdout: "once" });
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toMatchObject({ outcome: "refused" });
	});

	it("a real child is stopped by withdraw", async () => {
		const t = tools({ "/vault/use": [approved] });
		const running = await t.tools.run({ command: "sleep 30", entryId: "deploy" });
		expect(running).toMatchObject({ outcome: "running" });
		expect(await t.tools.withdraw({ jobId: String(running.jobId) })).toEqual({ withdrawn: true });
	});

	it("retries a connection error during background polling", async () => {
		const fake = fakeRun();
		const t = tools(
			{ "/vault/use": [pending("req-retry")], "/vault/collect": [new Error("fetch failed"), approved] },
			fake.run,
			{ retryMs: 1 },
		);
		const started = await t.tools.run({ command: "retry", entryId: "deploy" });
		await fake.waitForStart();
		expect(t.posted.filter((item) => item.path === "/vault/collect")).toHaveLength(2);
		expect(t.notifications).toHaveLength(0);
		fake.handles[0].resolve(exited("retried"));
		expect(await collectAfterNotice(t, started)).toMatchObject({ outcome: "ran", stdout: "retried" });
	});

	it("notifies once when settled without an active collect, then collects once", async () => {
		const fake = fakeRun();
		const t = tools({ "/vault/use": [approved] }, fake.run);
		const started = await t.tools.run({ command: "notify", entryId: "deploy" });
		fake.handles[0].resolve(exited("complete"));
		const notice = await t.nextNotice();
		expect(notice.stillWanted()).toBe(true);
		expect(t.notifications).toHaveLength(1);
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toMatchObject({ outcome: "ran" });
		expect(notice.stillWanted()).toBe(false);
		expect(t.notifications).toHaveLength(1);
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toEqual({
			outcome: "refused",
			reason: "no such job",
		});
	});

	it("settles refused when the command cannot start, and refuses a withdraw once the child exited", async () => {
		const broken = tools({ "/vault/use": [approved] }, () => {
			throw new Error("no tmpfs");
		});
		const failed = await broken.tools.run({ command: "deploy", entryId: "deploy", shape: "file" });
		expect(await collectAfterNotice(broken, failed)).toMatchObject({ outcome: "refused" });

		const fake = fakeRun();
		const t = tools({ "/vault/use": [approved], "/vault/capture": [new Promise(() => undefined)] }, fake.run);
		const started = await t.tools.run({ command: "mint", entryId: "deploy", capture: { publicTitle: "x" } });
		fake.handles[0].resolve(exited("minted"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await t.tools.withdraw({ jobId: String(started.jobId) })).toMatchObject({ withdrawn: false });
	});

	it("capture stores the raw stdout as a new entry and answers its id in place of the output", async () => {
		const t = tools({
			"/vault/capture": [
				{ id: "minted" },
				httpError(409, { error: "an entry with that title exists" }),
				{ id: "from-noise" },
			],
			"/vault/use": [approved],
		});
		const captured = await runAndCollect(t, {
			command: "printf 'generated\\n'",
			capture: { publicTitle: "DB password" },
		});
		expect(captured).toMatchObject({ outcome: "ran", captured: "minted" });
		expect(captured).not.toHaveProperty("stdout");
		expect(t.posted[0]).toEqual({
			path: "/vault/capture",
			body: { publicTitle: "DB password", value: "generated\n" },
		});

		// A value derived from the injected one is stored raw, never scrubbed.
		const derived = await runAndCollect(t, {
			command: 'printf "%s-derived" "$VAULT_VALUE"',
			entryId: "deploy",
			capture: { publicTitle: "Derived" },
		});
		expect(derived).toMatchObject({ captured: null, reason: expect.any(String) });
		expect(t.posted.at(-1)).toEqual({
			path: "/vault/capture",
			body: { publicTitle: "Derived", value: `${SECRET}-derived` },
		});
		expect(JSON.stringify(derived)).not.toContain(SECRET);

		expect(await runAndCollect(t, { command: "printf '\\n'", capture: { publicTitle: "empty" } })).toMatchObject({
			captured: null,
		});
		// A cut stdout would store a piece of a secret as the whole of it.
		const cut = await runAndCollect(t, {
			command: "head -c 1100000 /dev/zero | tr '\\0' x",
			capture: { publicTitle: "cut" },
		});
		expect(cut).toMatchObject({ truncated: true, captured: null });
		// A noisy stderr is not a reason to drop a complete stdout.
		const noisy = await runAndCollect(t, {
			command: "printf 'kept\\n'; head -c 100000 /dev/zero | tr '\\0' x >&2",
			capture: { publicTitle: "noisy" },
		});
		expect(noisy).toMatchObject({ truncated: true, captured: expect.any(String) });
		expect(
			await runAndCollect(t, { command: "head -c 9000 /dev/zero | tr '\\0' x", capture: { publicTitle: "big" } }),
		).toMatchObject({
			captured: null,
		});
		expect(t.posted.filter((p) => p.path === "/vault/capture")).toHaveLength(3);
		expect(await t.tools.run({ command: "true" })).toMatchObject({ outcome: "refused" });
	});

	it("does not settle a capture job until the capture route answers", async () => {
		const fake = fakeRun();
		const capture = deferred<unknown>();
		const t = tools({ "/vault/capture": [capture.promise] }, fake.run);
		const started = await t.tools.run({ command: "printf 'captured\\n'", capture: { publicTitle: "Captured" } });
		fake.handles[0].resolve(exited("captured\n"));
		await t.waitForPost("/vault/capture");
		expect(await t.tools.collect({ jobId: String(started.jobId) })).toEqual(started);
		expect(t.notifications).toHaveLength(0);
		capture.resolve({ id: "capture-id" });
		expect(await collectAfterNotice(t, started)).toMatchObject({ outcome: "ran", captured: "capture-id" });
	});

	it("shutdown withdraws every pending request and stops every child", async () => {
		const fake = fakeRun();
		const t = tools(
			{ "/vault/use": [pending("req-4"), approved], "/vault/withdraw": [{ withdrawn: true }] },
			fake.run,
			{ retryMs: 1 },
		);
		await t.tools.run({ command: "true", entryId: "deploy" });
		const running = await t.tools.run({ command: "long", entryId: "deploy" });
		await t.tools.shutdown();
		expect(t.posted.at(-1)).toEqual({ path: "/vault/withdraw", body: { requestId: "req-4" } });
		expect(fake.handles[0].killed).toBe(true);
		expect(await t.tools.collect({ jobId: String(running.jobId) })).toMatchObject({ outcome: "refused" });
	});

	it("search passes the query through, renders a route error, and the capability is gated", async () => {
		const t = tools({
			"/vault/search": [{ entries: [] }, { entries: [] }, httpError(401, { error: "not bound" })],
		});
		await t.tools.search({ query: "deploy" });
		await t.tools.search({});
		expect(t.posted.map((p) => p.body)).toEqual([{ query: "deploy" }, {}]);
		expect(await t.tools.search({})).toMatchObject({ outcome: "refused", reason: "search: not bound" });
		expect(GATED_CAPABILITY_IDS).toContain("vault");
		expect(renderCapabilities([{ id: "vault", instructions: "From the phone." }], null)).toContain("vault_run");
	});
});
