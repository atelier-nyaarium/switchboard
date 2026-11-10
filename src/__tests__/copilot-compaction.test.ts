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
	/** `stat` and `tail | head` over one held file, as a container's shell answers them. */
	function container(held: { text?: string }) {
		const asked: string[][] = [];
		const exec = async (argv: string[]): Promise<string> => {
			asked.push(argv);
			if (held.text === undefined) throw new Error("No such file or directory");
			const bytes = Buffer.from(held.text);
			if (argv[0] === "stat") return `${bytes.length}\n`;
			const [from, , length] = argv.slice(-3).map(Number);
			return bytes.subarray((from as number) - 1, (from as number) - 1 + (length as number)).toString("utf8");
		};
		return { exec, asked };
	}

	it("reads its size and an appended byte range through the container, by the container's path", async () => {
		const held = { text: `${NOISE}${START}` };
		const { exec, asked } = container(held);
		const file = execEventsFile(exec, compactionEventsPath("/home/vscode", SESSION));

		expect(await file.size()).toBe(Buffer.byteLength(held.text));
		expect(await file.read(NOISE.length, held.text.length)).toBe(START);
		expect(
			asked.every((argv) => argv.includes(`/home/vscode/.copilot/session-state/${SESSION}/events.jsonl`)),
		).toBe(true);
	});

	it("reads a file it cannot reach as absent, so a poll skips rather than throws", async () => {
		const changes: Array<[string, boolean]> = [];
		const { exec } = container({});
		const instance = createCompactionFollower({
			file: () => execEventsFile(exec, "/home/vscode/missing"),
			pollMs: 60_000,
			onChange: (team, compacting) => changes.push([team, compacting]),
		});

		await instance.setFollows([
			{ team: "app.abc", copilotSessionId: SESSION, place: { kind: "devcontainer", name: "app" } },
		]);
		await instance.poll();

		expect(changes).toEqual([]);
		instance.stop();
	});
});
