import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Watcher } from "../gateway/assistant/watcher.js";
import {
	type AssistantHomePort,
	type AssistantStageDeps,
	type AssistantVault,
	composeAssistant,
} from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_RESERVE_KEY, ASSISTANT_SESSION_NAME, ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { ASSISTANT_ACTION_PATH } from "../shared/schemasAssistantActions.js";
import type { AssistantHomeRecord, AssistantHomeSealed } from "../shared/schemasAssistantHome.js";
import type { AssistantFieldSpec, AssistantRule, AssistantWatcherRules } from "../shared/schemasAssistantRules.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import { SessionStore } from "../shared/session-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const NOTES = "~/projects/notes";
const T0 = 1_800_000_000_000;
const LOCAL_GATEWAY = "gateway-local";
const OTHER_GATEWAY = "gateway-elsewhere";
const FIELDS: AssistantFieldSpec[] = [{ kind: "text", field: "reason", label: "Reason" }];
const HOME_ENVELOPE: ContentEnvelope = {
	v: 1,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.alloc(16).toString("base64"),
};

type HomeOpen = ReturnType<AssistantHomePort["open"]>;
type HomeReport = Parameters<AssistantHomePort["report"]>[0];
type StageAssistant = ReturnType<typeof composeAssistant>;

interface StageOptions {
	dataDir?: string;
	store?: SessionStore;
	watchers?: Watcher[];
	ambient?: FakeAmbient;
	fetch?: AssistantStageDeps["fetch"];
	vault?: AssistantVault;
	saveSessions?: () => void;
	/** The Router's answers to reports, in order; then accepted. */
	reportAnswers?: Awaited<ReturnType<AssistantHomePort["report"]>>[];
}

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-"));
	dirs.push(dir);
	return dir;
}

function vault(
	initial: Record<string, string[]> = {},
	usable: (entryId: string) => Promise<boolean> = async () => true,
) {
	const grants = new Map(Object.entries(initial));
	const held: AssistantVault = {
		watcherGrants: (watcherId) => grants.get(watcherId) ?? [],
		setWatcherGrants: (watcherId, entryIds) => void grants.set(watcherId, entryIds),
		readForWatcher: async () => ({ kind: "released", value: "token" }),
		usableHere: usable,
	};
	return held;
}

function counting(options: { repeat?: boolean; onPoll?: () => void } = {}): Watcher & { polls: number } {
	const watcher = {
		id: "github",
		label: "GitHub",
		fieldSpecs: FIELDS,
		polls: 0,
		poll: async () => {
			watcher.polls += 1;
			options.onPoll?.();
			return options.repeat
				? ({ kind: "unchanged", nextPollMs: 60_000 } as const)
				: ({ kind: "stopped", reason: "test" } as const);
		},
	};
	return watcher;
}

function rules(items: AssistantRule[] = []): AssistantWatcherRules {
	return { rules: items, otherwise: { action: "inbox", revision: 0 }, revision: items.length };
}

function rule(id: string, action: AssistantRule["action"] = "wake"): AssistantRule {
	return {
		id,
		conditions: [{ field: "reason", test: "is", value: "mention" }],
		action,
		revision: 0,
	};
}

function carriedSettings(options: { approveEverySend?: boolean; rules?: AssistantRule[]; grant?: string | null } = {}) {
	return {
		approveEverySend: options.approveEverySend ?? true,
		watchers: [{ id: "github", rules: rules(options.rules), grant: options.grant ?? null }],
	};
}

function sealedHome(workdirPath = NOTES, carried: AssistantHomeSealed["carried"] = null): AssistantHomeSealed {
	return { workdirPath, carried };
}

function homeRecord(version: number, gatewayId: string | null = LOCAL_GATEWAY): AssistantHomeRecord {
	return { version, gatewayId, sealed: gatewayId === null ? null : HOME_ENVELOPE };
}

function stage(options: StageOptions = {}) {
	const dataDir = options.dataDir ?? freshDir();
	const store = options.store ?? new SessionStore({ ambient: processAmbient() });
	let rememberedAssistant: ReturnType<SessionStore["getByTeam"]>;
	let waking = false;
	let endAttempts = 0;
	const authority = {
		resolveConfirmedManagedSession: (req: Request) => {
			const caller = req.headers.get("x-caller");
			if (caller !== "assistant") return caller ? { spawn: "host", id: caller } : undefined;
			const current = store.getByTeam(ASSISTANT_TEAM);
			if (current) rememberedAssistant = current;
			return current ?? rememberedAssistant;
		},
	};
	const assistant = composeAssistant({
		dataDir,
		localGatewayId: LOCAL_GATEWAY,
		ambient: options.ambient ?? processAmbient(),
		sessions: { sessionStore: store, presence: store, sessionAuthority: authority } as never,
		saveSessions: options.saveSessions ?? (() => {}),
		vault: options.vault ?? vault(),
		routes: () => {
			throw new Error("no Domain");
		},
		blobSize: () => null,
		lastDeliverySeq: () => 0,
		fetch: options.fetch ?? (async () => new Response(null, { status: 304 })),
		...(options.watchers ? { watchers: options.watchers } : {}),
	});
	const opened = new Map<number, HomeOpen>();
	const reports: HomeReport[] = [];
	assistant.bindHome({
		open: (record) => opened.get(record.version) ?? { kind: "refused", reason: "missing home" },
		report: async (mark) => {
			reports.push(mark);
			return options.reportAnswers?.shift() ?? "accepted";
		},
		endSession: async () => {
			endAttempts += 1;
			if (waking) throw new Error("the session is waking");
			store.forget(ASSISTANT_TEAM);
		},
	});
	const followRecord = (
		record: AssistantHomeRecord | null,
		options: { registered?: boolean; open?: HomeOpen } = {},
	) => {
		if (record?.gatewayId === LOCAL_GATEWAY)
			opened.set(record.version, options.open ?? { kind: "ok", sealed: sealedHome() });
		return assistant.follow(record, { registered: options.registered ?? false });
	};
	const followHome = (
		version = 1,
		gatewayId: string | null = LOCAL_GATEWAY,
		openedResult: HomeOpen = { kind: "ok", sealed: sealedHome() },
		registered = false,
	) => followRecord(homeRecord(version, gatewayId), { open: openedResult, registered });
	return {
		assistant,
		store,
		dataDir,
		reports,
		followHome,
		followRecord,
		setWaking: (value: boolean) => {
			waking = value;
		},
		endAttempts: () => endAttempts,
		rememberAssistant: () => {
			rememberedAssistant = store.getByTeam(ASSISTANT_TEAM);
		},
	};
}

async function stopped(assistant: StageAssistant, ambient: FakeAmbient) {
	const done = assistant.stop();
	await ambient.advance(5_000);
	await done;
}

describe("the assistant's session", () => {
	it("follows its home, reserves the session, and refuses a plain forget", async () => {
		const { assistant, store, followHome } = stage();

		const before = assistant.reserves(ASSISTANT_TEAM);
		await followHome();
		const placed = assistant.console.state();

		expect(before).toBe(false);
		expect(placed).toMatchObject({ workdir: NOTES, team: ASSISTANT_TEAM });
		expect(store.list()).toHaveLength(1);
		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(true);
		expect(assistant.forgetRefusal(ASSISTANT_TEAM)).not.toBeNull();
	});

	it("stops acting when a newer home cannot be saved", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting({ repeat: true });
		const test = stage({ ambient, watchers: [watcher] });
		test.assistant.start();
		await test.followHome();
		await ambient.advance(0);
		const polled = watcher.polls;

		fs.chmodSync(test.dataDir, 0o500);
		try {
			await expect(test.followHome(2, OTHER_GATEWAY)).rejects.toThrow();
		} finally {
			fs.chmodSync(test.dataDir, 0o700);
		}
		await ambient.advance(120_000);
		await stopped(test.assistant, ambient);

		expect(polled).toBeGreaterThan(0);
		expect(watcher.polls).toBe(polled);
		expect(test.assistant.placed()).toBe(false);
	});

	it("reports again until the Router takes the report", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const test = stage({ ambient, watchers: [counting()], reportAnswers: ["retry", "retry"] });
		test.assistant.start();
		await test.followHome();
		for (let tick = 0; tick < 4; tick += 1) await ambient.advance(10_000);
		await stopped(test.assistant, ambient);

		expect(test.reports.map((report) => report.outcome)).toEqual(["placed", "placed", "placed"]);
	});

	it("reports a folder refusal and preserves a session it did not make", async () => {
		const fresh = stage();
		await fresh.followHome(1, LOCAL_GATEWAY, {
			kind: "ok",
			sealed: sealedHome("relative/notes"),
		});
		const squatted = new SessionStore({ ambient: processAmbient() });
		squatted.adoptById(ASSISTANT_SESSION_NAME, { spawn: "host", sessionLabel: "mine" });
		const held = stage({ store: squatted });
		await held.followHome();

		expect(fresh.reports[0]).toMatchObject({ version: 1, outcome: "refused", reason: expect.any(String) });
		expect(fresh.store.list()).toHaveLength(0);
		expect(squatted.getByTeam(ASSISTANT_TEAM)).toMatchObject({ sessionLabel: "mine", workdirPath: undefined });
		expect(held.reports[0]).toMatchObject({ version: 1, outcome: "refused", reason: expect.any(String) });
		expect(held.assistant.reserves(ASSISTANT_TEAM)).toBe(false);
	});

	it("polls only while placed and drops grants on let-go", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting({ repeat: true });
		const test = stage({ ambient, watchers: [watcher] });
		test.assistant.start();
		await ambient.advance(0);
		const unplaced = watcher.polls;
		await test.followHome();
		await ambient.advance(0);
		const placed = watcher.polls;
		await test.assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		await ambient.advance(60_000);
		const polling = watcher.polls;

		await test.followHome(2, OTHER_GATEWAY);
		await ambient.advance(24 * 60 * 60 * 1000);
		const released = test.assistant.console.state();
		await stopped(test.assistant, ambient);

		expect(unplaced).toBe(0);
		expect(placed).toBeGreaterThan(0);
		expect(polling).toBeGreaterThan(placed);
		expect(watcher.polls).toBe(polling);
		expect(test.store.getByTeam(ASSISTANT_TEAM)).toBeUndefined();
		expect(released).toMatchObject({ workdir: null, team: null });
		expect(released.watchers[0]?.grants).toEqual([]);
		expect(test.assistant.placed()).toBe(false);
		await expect(test.assistant.console.setWatcherGrants("github", ["gh-token"])).rejects.toThrow();
	});

	it("reports a failed session save and rolls the placement back", async () => {
		let save = false;
		const test = stage({
			saveSessions: () => {
				if (!save) throw new Error("disk full");
			},
		});

		await test.followHome();
		const refused = test.assistant.console.state();
		save = true;
		await test.followHome(2);
		const placed = test.assistant.console.state();

		expect(test.reports[0]).toMatchObject({ version: 1, outcome: "refused", reason: expect.any(String) });
		expect(refused).toMatchObject({ workdir: null, team: null });
		expect(test.store.getByTeam(ASSISTANT_TEAM)?.workdirPath).toBe(NOTES);
		expect(placed).toMatchObject({ workdir: NOTES, team: ASSISTANT_TEAM });
	});

	it("starts with no grants after applying a new home", async () => {
		const held = vault({ github: ["left-behind"] });
		const test = stage({ vault: held });

		await test.followHome();

		expect(test.assistant.console.state().watchers[0]?.grants).toEqual([]);
	});

	it("asks GitHub only after a secret is granted", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const asked: string[] = [];
		const test = stage({
			ambient,
			fetch: async (_url, init) => {
				asked.push((init.headers as Record<string, string>).Authorization ?? "");
				return new Response(null, { status: 304 });
			},
		});
		test.assistant.start();
		await test.followHome();
		await ambient.advance(0);
		const ungranted = test.assistant.console.state().watchers[0]?.stopped;

		await test.assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		await stopped(test.assistant, ambient);

		expect(ungranted).toBe("needs a secret");
		expect(asked).toEqual(["Bearer token"]);
	});

	it("lets go to another Gateway and resets its local settings", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		let assistant: StageAssistant;
		const watcher = counting({
			repeat: true,
			onPoll: () => {
				void assistant.console.state();
			},
		});
		const test = stage({ ambient, watchers: [watcher] });
		assistant = test.assistant;
		assistant.start();
		await test.followHome(1, LOCAL_GATEWAY, {
			kind: "ok",
			sealed: sealedHome(NOTES, carriedSettings({ approveEverySend: false, rules: [rule("carried")] })),
		});
		await ambient.advance(0);
		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		await assistant.console.putRule("github", rule("local", "inbox"));
		await assistant.console.setSafety(false);
		test.rememberAssistant();
		const polls = watcher.polls;

		await test.followHome(2, OTHER_GATEWAY);
		const state = assistant.console.state();
		const action = assistant.routes.get(ASSISTANT_ACTION_PATH);
		if (!action) throw new Error("no action route");
		const answer = await action(new Request("http://gateway/", { headers: { "x-caller": "assistant" } }), {
			action: "github_done",
			callId: "old-session",
			params: { ids: ["1"] },
		}).then((response) => response.json());
		await ambient.advance(120_000);
		await stopped(assistant, ambient);

		expect(test.store.getByTeam(ASSISTANT_TEAM)).toBeUndefined();
		expect(state.watchers[0]?.grants).toEqual([]);
		expect(state.watchers[0]?.rules?.rules).toEqual([]);
		expect(state.watchers[0]?.rules?.otherwise.action).toBe("inbox");
		expect(state.approveEverySend).toBe(true);
		expect(answer).toEqual({ kind: "not_assistant" });
		expect(assistant.placed()).toBe(false);
		expect(watcher.polls).toBe(polls);
	});

	it("lets go when nobody is named", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting({ repeat: true });
		const test = stage({ ambient, watchers: [watcher] });
		test.assistant.start();
		await test.followHome();
		await ambient.advance(0);

		await test.followHome(2, null);
		const polls = watcher.polls;
		await ambient.advance(120_000);
		await stopped(test.assistant, ambient);

		expect(test.store.getByTeam(ASSISTANT_TEAM)).toBeUndefined();
		expect(test.assistant.placed()).toBe(false);
		expect(watcher.polls).toBe(polls);
	});

	it("keeps a held session and its lanes when the home was never written", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById(ASSISTANT_SESSION_NAME, {
			spawn: "host",
			sessionLabel: "Assistant",
			workdirPath: NOTES,
			mintedFrom: ASSISTANT_RESERVE_KEY,
		});
		const watcher = counting({ repeat: true });
		const test = stage({ store, ambient, watchers: [watcher] });
		test.assistant.start();
		await ambient.advance(0);
		const before = watcher.polls;

		await test.followRecord(null);
		await ambient.advance(60_000);
		await stopped(test.assistant, ambient);

		expect(store.getByTeam(ASSISTANT_TEAM)?.workdirPath).toBe(NOTES);
		expect(test.assistant.placed()).toBe(true);
		expect(watcher.polls).toBeGreaterThan(before);
	});

	it("applies one version once across a repeat and a restart", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const store = new SessionStore({ ambient: processAmbient() });
		const first = stage({ ambient, store });
		await first.followHome();
		await first.assistant.console.putRule("github", rule("edited", "wake"));
		const edited = first.assistant.console.state().watchers[0]?.rules;

		await first.followHome();
		const repeated = first.assistant.console.state().watchers[0]?.rules;
		const restarted = stage({ dataDir: first.dataDir, store, ambient });
		restarted.assistant.start();
		await restarted.followHome();
		const afterRestart = restarted.assistant.console.state().watchers[0]?.rules;
		await stopped(restarted.assistant, ambient);

		expect(repeated).toEqual(edited);
		expect(afterRestart).toEqual(edited);
	});

	it("lands carried rules before the first poll", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		let assistant: StageAssistant;
		let firstRules: AssistantWatcherRules | undefined;
		const watcher = counting({
			onPoll: () => {
				firstRules = assistant.console.state().watchers[0]?.rules;
			},
		});
		const test = stage({ ambient, watchers: [watcher] });
		assistant = test.assistant;
		assistant.start();
		const carried = rule("carried", "wake");
		await test.followHome(1, LOCAL_GATEWAY, {
			kind: "ok",
			sealed: sealedHome(NOTES, carriedSettings({ rules: [carried] })),
		});
		await ambient.advance(0);
		await stopped(assistant, ambient);

		expect(firstRules?.rules.map((item) => item.id)).toEqual(["carried"]);
	});

	it("retries a forget refused while the session wakes", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const test = stage({ ambient, watchers: [counting({ repeat: true })] });
		await test.followHome();
		test.setWaking(true);
		await test.followHome(2, OTHER_GATEWAY);
		const firstAttempt = test.endAttempts();
		test.setWaking(false);
		await ambient.advance(29_999);
		const beforeRetry = test.endAttempts();
		await ambient.advance(1);
		await ambient.advance(0);

		expect(firstAttempt).toBe(1);
		expect(beforeRetry).toBe(1);
		expect(test.endAttempts()).toBe(2);
		expect(test.store.getByTeam(ASSISTANT_TEAM)).toBeUndefined();
		expect(test.assistant.placed()).toBe(false);
		await stopped(test.assistant, ambient);
	});

	it("boots lanes from a placed home mark", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const store = new SessionStore({ ambient: processAmbient() });
		const first = stage({ ambient, store });
		await first.followHome();
		await stopped(first.assistant, ambient);
		const watcher = counting();
		const restarted = stage({ dataDir: first.dataDir, store, ambient, watchers: [watcher] });

		restarted.assistant.start();
		await ambient.advance(0);
		await stopped(restarted.assistant, ambient);

		expect(watcher.polls).toBe(1);
		expect(restarted.assistant.placed()).toBe(true);
	});

	it("does not boot lanes from a let-go mark and resumes forgetting", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const store = new SessionStore({ ambient: processAmbient() });
		const first = stage({ ambient, store });
		await first.followHome();
		first.setWaking(true);
		await first.followHome(2, OTHER_GATEWAY);
		await stopped(first.assistant, ambient);
		const watcher = counting();
		const restarted = stage({ dataDir: first.dataDir, store, ambient, watchers: [watcher] });

		restarted.assistant.start();
		await ambient.advance(0);
		await stopped(restarted.assistant, ambient);

		expect(watcher.polls).toBe(0);
		expect(store.getByTeam(ASSISTANT_TEAM)).toBeUndefined();
		expect(restarted.assistant.console.state()).toMatchObject({ workdir: null, team: null });
		expect(restarted.assistant.placed()).toBe(false);
	});

	it("reports an unopened home and starts no lanes", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting();
		const test = stage({ ambient, watchers: [watcher] });
		test.assistant.start();
		await test.followHome(1, LOCAL_GATEWAY, {
			kind: "refused",
			reason: "content key epoch 3 is not here yet",
		});
		await ambient.advance(0);
		await stopped(test.assistant, ambient);

		expect(test.reports[0]).toMatchObject({
			version: 1,
			outcome: "refused",
			reason: expect.stringContaining("epoch"),
		});
		expect(watcher.polls).toBe(0);
		expect(test.assistant.placed()).toBe(false);
	});

	it("drops a carried grant this Gateway cannot use", async () => {
		const grants = vault({}, async () => false);
		const test = stage({ vault: grants });
		await test.followHome(1, LOCAL_GATEWAY, {
			kind: "ok",
			sealed: sealedHome(NOTES, carriedSettings({ grant: "remote-entry" })),
		});

		expect(test.assistant.console.state().watchers[0]?.grants).toEqual([]);
		expect(test.reports[0]).toMatchObject({ version: 1, outcome: "placed" });
	});

	it("resends an applied report only at registration", async () => {
		const test = stage();
		await test.followHome();
		test.reports.length = 0;
		await test.followHome(1, LOCAL_GATEWAY, { kind: "ok", sealed: sealedHome() }, false);
		const pushed = [...test.reports];
		await test.followHome(1, LOCAL_GATEWAY, { kind: "ok", sealed: sealedHome() }, true);

		expect(pushed).toEqual([]);
		expect(test.reports).toEqual([{ version: 1, outcome: "placed" }]);
	});
});
