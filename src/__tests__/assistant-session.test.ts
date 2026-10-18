import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Watcher } from "../gateway/assistant/watcher.js";
import { composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const NOTES = "~/projects/notes";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-"));
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function stage(workdir: string | undefined, store = new SessionStore({ ambient: processAmbient() })) {
	const assistant = composeAssistant({
		workdir,
		dataDir,
		ambient: processAmbient(),
		sessions: { sessionStore: store, presence: store } as never,
	});
	return { assistant, store };
}

describe("the assistant's session", () => {
	it("is provisioned once, reserved, and never forgotten", () => {
		const first = stage(NOTES);
		const again = stage(NOTES, first.store);

		expect(again.store.list()).toHaveLength(1);
		expect(again.store.getByTeam(ASSISTANT_TEAM)?.workdirPath).toBe(NOTES);
		expect(again.assistant.reserves(ASSISTANT_TEAM)).toBe(true);
		expect(again.assistant.forgetRefusal(ASSISTANT_TEAM)).not.toBeNull();
		expect(again.assistant.reserves("host.other")).toBe(false);
		expect(again.assistant.forgetRefusal("host.other")).toBeNull();
	});

	it("claims nothing a session it did not make already holds", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("assistant", { spawn: "host", sessionLabel: "mine" });
		const { assistant } = stage(NOTES, store);

		expect(store.getByTeam(ASSISTANT_TEAM)).toMatchObject({ sessionLabel: "mine", workdirPath: undefined });
		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(false);
		expect(assistant.forgetRefusal(ASSISTANT_TEAM)).toBeNull();
	});

	it("follows the configured workdir, never a stored one", () => {
		const { store } = stage("~/somewhere-else");
		stage(NOTES, store);

		expect(store.getByTeam(ASSISTANT_TEAM)?.workdirPath).toBe(NOTES);
	});

	it("treats its record as ordinary once unconfigured", () => {
		const { store } = stage(NOTES);
		const { assistant } = stage(undefined, store);

		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(false);
		expect(assistant.forgetRefusal(ASSISTANT_TEAM)).toBeNull();
	});

	it("polls its watchers only when configured", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 0 });
		let polls = 0;
		const watcher: Watcher = {
			id: "github",
			poll: async () => {
				polls += 1;
				return { kind: "stopped", reason: "test" };
			},
		};
		for (const workdir of [undefined, NOTES]) {
			const sessionStore = new SessionStore({ ambient: processAmbient() });
			const assistant = composeAssistant({
				workdir,
				dataDir,
				ambient,
				sessions: { sessionStore, presence: sessionStore } as never,
				watchers: [watcher],
			});
			assistant.start();
			await ambient.advance(0);
			const stopping = assistant.stop();
			await ambient.advance(5_000);
			await stopping;
		}

		expect(polls).toBe(1);
	});

	it("provisions nothing for a working directory the host cannot take", () => {
		const { assistant, store } = stage("relative/notes");

		expect(store.list()).toHaveLength(0);
		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(false);
	});
});
