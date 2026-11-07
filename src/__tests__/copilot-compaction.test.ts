import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compactionAfter,
	compactionEventsPath,
	createCompactionFollower,
} from "../mcp/devcontainer/copilotCompaction.js";

const SESSION = "f67a0b0b-1508-4343-804c-2e5c284caf71";
const START = `{"type":"session.compaction_start","data":{"currentTokens":160544},"id":"a","timestamp":"t"}\n`;
const COMPLETE = `{"type":"session.compaction_complete","data":{"success":true},"id":"b","timestamp":"t"}\n`;
const NOISE = `{"type":"session.usage_record","data":{"tokens":1},"id":"c","timestamp":"t"}\n`;

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-compaction-"));
	homes.push(dir);
	return dir;
}

function follower(root: string) {
	const changes: Array<[string, boolean]> = [];
	const instance = createCompactionFollower({
		home: root,
		pollMs: 60_000,
		onChange: (team, compacting) => changes.push([team, compacting]),
	});
	const file = compactionEventsPath(root, SESSION);
	const append = (text: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, text);
	};
	return { instance, changes, file, append };
}

describe("the Copilot compaction follower", () => {
	it("reads the last compaction line of a chunk", () => {
		expect(compactionAfter(`${NOISE}${START}${NOISE}`, false)).toBe(true);
		expect(compactionAfter(`${START}${COMPLETE}`, false)).toBe(false);
		expect(compactionAfter(NOISE, true)).toBe(true);
	});

	it("follows appended events, carrying a cut line, and seeds from a file already mid-compaction", () => {
		const root = home();
		const { instance, changes, append } = follower(root);
		append(`${NOISE}${START}`);
		instance.setFollows([{ team: "host.abc", copilotSessionId: SESSION }]);
		expect(changes).toEqual([["host.abc", true]]);

		const [head, tail] = [COMPLETE.slice(0, 20), COMPLETE.slice(20)];
		append(head);
		instance.poll();
		append(tail);
		instance.poll();
		append(NOISE);
		instance.poll();
		append(START);
		instance.poll();
		instance.poll();
		expect(changes).toEqual([
			["host.abc", true],
			["host.abc", false],
			["host.abc", true],
		]);
		instance.stop();
	});

	it("starts clear for a missing file, clears on truncation, and stops reporting a dropped team", () => {
		const root = home();
		const { instance, changes, file, append } = follower(root);
		instance.setFollows([{ team: "host.abc", copilotSessionId: SESSION }]);
		instance.poll();
		expect(changes).toEqual([]);

		append(START);
		instance.poll();
		fs.writeFileSync(file, "");
		instance.poll();
		expect(changes).toEqual([
			["host.abc", true],
			["host.abc", false],
		]);

		append(START);
		instance.setFollows([]);
		instance.poll();
		expect(changes).toHaveLength(2);
		instance.stop();
	});
});
