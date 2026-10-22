import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createActionDispatch } from "../gateway/assistant/actionDispatch.js";
import { createGithubClient } from "../gateway/assistant/githubClient.js";
import { GithubDone } from "../gateway/assistant/githubDone.js";
import { createSourceLanes } from "../gateway/assistant/sourceLane.js";
import { ASSISTANT_WAITS } from "../gateway/assistant/waits.js";
import { FRESH_STATE } from "../gateway/assistant/watcherState.js";
import { type AssistantVault, composeAssistant } from "../gateway/compose/composeAssistant.js";
import type { DeliverToOwnerOptions } from "../gateway/consolePushOps.js";
import { actionText } from "../mcp/assistant/actionTools.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { ConsolePushEntrySchema } from "../shared/federation-protocol.js";
import {
	ASSISTANT_ACTION_PATH,
	ASSISTANT_ACTIONS,
	type AssistantActionResult,
} from "../shared/schemasAssistantActions.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const API = "https://api.github.com";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const thread = (id: string) => ({
	id,
	updated_at: "2026-10-18T10:00:00Z",
	reason: "subscribed",
	subject: { title: `Release ${id}`, type: "Release", url: null },
	repository: { full_name: "atelier/app" },
});

/** `404` means missing; poll idle. */
function github() {
	const asked: string[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		const at = url.replace(API, "");
		if (at.startsWith("/notifications?")) return new Response(null, { status: 304 });
		asked.push(`${method} ${at}`);
		const id = at.match(/threads\/(\d+)$/)?.[1] ?? "";
		if (id === "404") return new Response(null, { status: 404 });
		if (method === "PATCH") return new Response(null, { status: 205 });
		if (method === "DELETE") return new Response(null, { status: 204 });
		return Response.json(thread(id));
	};
	return { fetch, asked };
}

async function placed() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-actions-"));
	dirs.push(dataDir);
	const store = new SessionStore({ ambient: processAmbient() });
	const grants = new Map<string, string[]>();
	const vault: AssistantVault = {
		watcherGrants: (watcherId) => grants.get(watcherId) ?? [],
		setWatcherGrants: (watcherId, entryIds) => void grants.set(watcherId, entryIds),
		readForWatcher: async () => ({ kind: "released", value: "ghp_test" }),
	};
	const delivered: DeliverToOwnerOptions[] = [];
	const source = github();
	const authority = {
		resolveConfirmedManagedSession: (req: Request) => {
			const caller = req.headers.get("x-caller");
			if (caller === "assistant") return store.getByTeam(ASSISTANT_TEAM);
			return caller ? { spawn: "host", id: caller } : undefined;
		},
	};
	const assistant = composeAssistant({
		dataDir,
		// Polling stays idle.
		ambient: fakeAmbient({ drive: "manual", now: () => T0 }),
		sessions: { sessionStore: store, presence: store, sessionAuthority: authority } as never,
		saveSessions: () => {},
		vault,
		routes: () => ({
			deliverToOwner: (options) => {
				delivered.push(options);
				return true;
			},
			ownerSessionKey: (to) => `owner:${to}`,
		}),
		fetch: source.fetch,
	});
	assistant.start();
	await assistant.console.place("~/notes");
	await assistant.console.setWatcherGrants("github", ["gh"]);
	const route = assistant.routes.get(ASSISTANT_ACTION_PATH);
	if (!route) throw new Error("no action route");
	const call = async (body: unknown, caller = "assistant"): Promise<AssistantActionResult> => {
		const headers: Record<string, string> = caller ? { "x-caller": caller } : {};
		return (await route(new Request("http://gateway/", { headers }), body)).json();
	};
	return { assistant, call, delivered, asked: source.asked };
}

describe("an assistant action", () => {
	it("clears what GitHub confirms and records it in the assistant's own conversation as a response", async () => {
		const { assistant, call, delivered, asked } = await placed();

		const result = await call({
			action: "github_done",
			callId: "call-0001",
			params: { ids: ["7", "404"], summary: "The release is out." },
		});
		await assistant.stop();

		expect(result).toEqual({
			kind: "ran",
			recorded: true,
			answer: {
				threads: [
					{ threadId: "7", title: "Release 7", url: "https://github.com/atelier/app", outcome: "done" },
					{ threadId: "404", outcome: "not_found" },
				],
			},
		});
		expect(asked).toEqual([
			"GET /notifications/threads/7",
			"DELETE /notifications/threads/7",
			"PATCH /notifications/threads/7",
			"GET /notifications/threads/404",
		]);
		expect(delivered).toHaveLength(1);
		const [record] = delivered;
		expect(record?.entry).toMatchObject({
			kind: "assistant_record",
			session_id: `owner:${ASSISTANT_TEAM}`,
			notify: true,
			body: "The release is out.",
		});
		expect(ConsolePushEntrySchema.safeParse(record?.entry).success).toBe(true);
		expect(assistant.console.state().watchers[0]?.actions).toEqual([
			{
				key: "github_done",
				label: ASSISTANT_ACTIONS.github_done.label,
				description: ASSISTANT_ACTIONS.github_done.description,
			},
		]);
	});

	it("tells the model whether its summary was recorded, whatever stopped it", () => {
		const done = { threads: [{ threadId: "1", outcome: "done" as const }] };

		const refused = actionText({ kind: "refused", reason: "busy" }, null, true);
		const unrecorded = actionText({ kind: "ran", answer: done, recorded: false }, done, true);
		const recorded = actionText({ kind: "ran", answer: done, recorded: true }, done, true);
		const quiet = actionText({ kind: "ran", answer: done, recorded: false }, done, false);

		expect(refused).toMatch(/summary was not recorded/);
		expect(unrecorded).toMatch(/summary was not recorded/);
		expect(recorded).toMatch(/Recorded with your summary/);
		expect(quiet).not.toMatch(/summary/);
	});

	it("answers by its deadline when its lane never started it, and sends nothing when it starts late", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = github();
		const client = createGithubClient({
			fetch: source.fetch,
			token: async () => ({ kind: "token", value: "ghp_test", key: "gh" }),
			now: () => ambient.now(),
		});
		const lanes = createSourceLanes({
			ambient,
			state: { get: () => FRESH_STATE, put: () => true },
			watchers: [{ id: "github", poll: async () => ({ kind: "unchanged", nextPollMs: 60_000 }) }],
			sort: () => "wake",
			wake: () => null,
			to: "host.assistant",
			render: () => "",
		});
		const dispatch = createActionDispatch({
			actions: { github_done: new GithubDone(client) },
			ambient,
			write: lanes.write,
			record: () => true,
		});
		let free = () => {};
		// An earlier write holds the lane until freed.
		const blocker = lanes.write(
			"github",
			10 * ASSISTANT_WAITS.action,
			() =>
				new Promise<void>((resolve) => {
					free = resolve;
				}),
		);

		await ambient.advance(0);
		const answered = dispatch({ action: "github_done", callId: "call-0007", params: { ids: ["1"] } });
		await ambient.advance(0);
		await ambient.advance(ASSISTANT_WAITS.action);
		const result = await answered;
		free();
		await blocker;
		await ambient.advance(0);

		expect(result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/nothing was sent/) });
		expect(source.asked).toEqual([]);
	});

	it("joins a repeated call id, so a retry sends nothing twice, and clears quietly without a summary", async () => {
		const { assistant, call, delivered, asked } = await placed();
		const body = { action: "github_done", callId: "call-0002", params: { ids: ["8"] } };

		const [first, retried] = await Promise.all([call(body), call(body)]);
		await assistant.stop();

		expect(retried).toEqual(first);
		expect(asked.filter((line) => line.startsWith("DELETE"))).toEqual(["DELETE /notifications/threads/8"]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.entry).toMatchObject({ notify: false });
		expect(delivered[0]?.entry.body).toBeUndefined();
	});

	it("answers only the assistant, refuses what its declaration refuses, and records nothing that never reached GitHub", async () => {
		const { assistant, call, delivered } = await placed();
		const done = (callId: string, ids: string[]) => ({ action: "github_done", callId, params: { ids } });

		const stranger = await call(done("call-0003", ["1"]), "someone");
		const unbound = await call(done("call-0004", ["1"]), "");
		const malformed = await call(done("call-0005", ["not-a-thread"]));
		await assistant.console.setWatcherGrants("github", []);
		const ungranted = await call(done("call-0006", ["1"]));
		await assistant.stop();

		expect(stranger).toEqual({ kind: "not_assistant" });
		expect(unbound).toEqual({ kind: "unauthenticated" });
		expect(malformed.kind).toBe("refused");
		expect(ungranted).toMatchObject({
			kind: "ran",
			recorded: false,
			answer: { threads: [{ threadId: "1", outcome: "not_attempted" }] },
		});
		expect(delivered).toEqual([]);
	});
});
