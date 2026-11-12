import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compactionAfter,
	compactionEventsPath,
	createCompactionFollower,
	execEventsFile,
	localEventsFile,
} from "../mcp/devcontainer/copilotCompaction.js";

const SESSION = "f67a0b0b-1508-4343-804c-2e5c284caf71";
const START = `{"type":"session.compaction_start","data":{"currentTokens":160544},"id":"a","timestamp":"t"}\n`;
const COMPLETE = `{"type":"session.compaction_complete","data":{"success":true},"id":"b","timestamp":"t"}\n`;
const NOISE = `{"type":"session.usage_record","data":{"tokens":1},"id":"c","timestamp":"t"}\n`;
const HOST = { kind: "host", name: "host" } as const;

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
		file: ({ copilotSessionId }) => localEventsFile(compactionEventsPath(root, copilotSessionId)),
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

	it("follows appended events, carrying a cut line, and seeds from a file already mid-compaction", async () => {
		const root = home();
		const { instance, changes, append } = follower(root);
		append(`${NOISE}${START}`);
		await instance.setFollows([{ team: "host.abc", copilotSessionId: SESSION, place: HOST }]);
		expect(changes).toEqual([["host.abc", true]]);

		const [head, tail] = [COMPLETE.slice(0, 20), COMPLETE.slice(20)];
		append(head);
		await instance.poll();
		append(tail);
		await instance.poll();
		append(NOISE);
		await instance.poll();
		append(START);
		await instance.poll();
		await instance.poll();
		expect(changes).toEqual([
			["host.abc", true],
			["host.abc", false],
			["host.abc", true],
		]);
		instance.stop();
	});

	it("starts clear for a missing file, clears on truncation, and stops reporting a dropped team", async () => {
		const root = home();
		const { instance, changes, file, append } = follower(root);
		await instance.setFollows([{ team: "host.abc", copilotSessionId: SESSION, place: HOST }]);
		await instance.poll();
		expect(changes).toEqual([]);

		append(START);
		await instance.poll();
		fs.writeFileSync(file, "");
		await instance.poll();
		expect(changes).toEqual([
			["host.abc", true],
			["host.abc", false],
		]);

		append(START);
		await instance.setFollows([]);
		await instance.poll();
		expect(changes).toHaveLength(2);
		instance.stop();
	});
});

describe("a container's events file", () => {
	/** One held file's size and `dd` reads. */
	function container(held: { text?: string; down?: boolean }) {
		const asked: string[][] = [];
		const exec = async (argv: string[]): Promise<string> => {
			asked.push(argv);
			if (held.down) throw new Error("tmux command timed out");
			if (argv[0] !== "dd") return held.text === undefined ? "absent\n" : `${Buffer.byteLength(held.text)}\n`;
			if (held.text === undefined) throw new Error("dd: failed to open");
			const named = (name: string) =>
				Number(argv.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1));
			return Buffer.from(held.text)
				.subarray(named("skip"), named("skip") + named("count"))
				.toString("utf8");
		};
		return { exec, asked };
	}

	function followIn(held: { text?: string; down?: boolean }) {
		const changes: Array<[string, boolean]> = [];
		const { exec } = container(held);
		const instance = createCompactionFollower({
			file: () => execEventsFile(exec, compactionEventsPath("/home/vscode", SESSION)),
			pollMs: 60_000,
			onChange: (team, compacting) => changes.push([team, compacting]),
		});
		const place = { kind: "devcontainer", name: "app" } as const;
		return { instance, changes, follow: [{ team: "app.abc", copilotSessionId: SESSION, place }] };
	}

	it("holds the state and the offset through a failed exec mid-compaction, then reads on from there", async () => {
		const held = { text: `${NOISE}${START}`, down: false };
		const { instance, changes, follow } = followIn(held);
		await instance.setFollows(follow);

		held.down = true;
		await instance.poll();
		expect(changes).toEqual([["app.abc", true]]);
		held.down = false;
		held.text += COMPLETE;
		await instance.poll();

		expect(changes).toEqual([
			["app.abc", true],
			["app.abc", false],
		]);
		instance.stop();
	});

	it("reads its size and an appended byte range through the container, by the container's path", async () => {
		const held = { text: `${NOISE}${START}` };
		const { exec, asked } = container(held);
		const file = execEventsFile(exec, compactionEventsPath("/home/vscode", SESSION));

		expect(await file.size()).toBe(Buffer.byteLength(held.text));
		expect(await file.read(NOISE.length, held.text.length)).toBe(START);
		const path = `/home/vscode/.copilot/session-state/${SESSION}/events.jsonl`;
		expect(asked.every((argv) => argv.some((part) => part.endsWith(path)))).toBe(true);
	});

	it("says compacting ended when a follow is dropped mid-compaction", async () => {
		const { instance, changes, follow } = followIn({ text: `${NOISE}${START}` });
		await instance.setFollows(follow);
		await instance.setFollows([]);

		expect(changes).toEqual([
			["app.abc", true],
			["app.abc", false],
		]);
		instance.stop();
	});

	it("reads a missing file as absent, and seeds from its tail once it is back", async () => {
		const held: { text?: string } = {};
		const { instance, changes, follow } = followIn(held);
		await instance.setFollows(follow);
		await instance.poll();
		held.text = `${NOISE.repeat(3)}${START}`;
		await instance.poll();

		expect(changes).toEqual([["app.abc", true]]);
		instance.stop();
	});
});
