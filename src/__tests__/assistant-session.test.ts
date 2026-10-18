import { describe, expect, it } from "vitest";
import { composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { SessionStore } from "../shared/session-store.js";

const NOTES = "~/projects/notes";

function stage(workdir: string | undefined, store = new SessionStore({ ambient: processAmbient() })) {
	const assistant = composeAssistant({ workdir, sessions: { sessionStore: store, presence: store } as never });
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

	it("provisions nothing for a working directory the host cannot take", () => {
		const { assistant, store } = stage("relative/notes");

		expect(store.list()).toHaveLength(0);
		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(false);
	});
});
