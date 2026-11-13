import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTAINER_HOME } from "../mcp/devcontainer/containerSite.js";
import { createPurge, type PurgeDeps } from "../mcp/devcontainer/sessionPurge.js";
import { type HostPurgeOp, HostPurgeOpSchema, type TmuxTarget } from "../shared/host-op.js";
import { ownSessionFiles } from "../shared/session-files.js";

const HOME = "/home/fixture";
const CLAUDE = `${HOME}/.claude`;
const ID = "123e4567-e89b-42d3-a456-426614174000";
const HOST = { kind: "host", workdirHint: "~" } as const;
const BOX = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" } as const;
const PANE: TmuxTarget = { kind: "host", name: "host", sessionName: "work" };

function rig(
	options: {
		files?: string[];
		down?: boolean;
		exec?: (argv: string[]) => string;
		windows?: string;
		/** The Windows home translates and is not there. */
		unmounted?: boolean;
	} = {},
) {
	const files = new Set(options.files ?? []);
	/** Homes that are there, whatever they hold. */
	const homes = new Set([HOME, ...(options.windows && !options.unmounted ? [options.windows] : [])]);
	const log: string[] = [];
	const deps: PurgeDeps = {
		homeOf: (spawn) => {
			if (spawn === undefined) return { home: HOME, claudeDir: CLAUDE };
			return options.windows ? { home: options.windows, claudeDir: `${options.windows}/.claude` } : undefined;
		},
		files: {
			directories: (dir) => [
				...new Set(
					[...files]
						.filter((file) => file.startsWith(`${dir}/`) && file.slice(dir.length + 1).includes("/"))
						.map((file) => file.slice(dir.length + 1).split("/")[0] as string),
				),
			],
			exists: (file) =>
				homes.has(file) || [...files].some((held) => held === file || held.startsWith(`${file}/`)),
			remove: (file) => {
				for (const held of [...files]) if (held === file || held.startsWith(`${file}/`)) files.delete(held);
				log.push(`remove ${path.relative(HOME, file)}`);
			},
		},
		exec: async (target, argv) => {
			log.push(`exec ${target.kind} ${argv[0]}`);
			if (options.down) throw new Error("Error response from daemon: No such container: recipe-app");
			return options.exec?.(argv) ?? "";
		},
		closePane: async (pane, then) => {
			log.push(`close ${pane.sessionName}`);
			await then?.();
		},
		deleteThread: async (backend, _target, threadId) => {
			log.push(`thread ${backend} ${threadId}`);
			return "deleted";
		},
	};
	const purge = createPurge(deps);
	const run = (op: Omit<HostPurgeOp, "kind">) => purge(HostPurgeOpSchema.parse({ kind: "purge", ...op }));
	return { run, files, log };
}

describe("a purge at its place", () => {
	it("removes a host conversation's transcript and side folder from whichever project holds them", async () => {
		const r = rig({
			files: [
				`${CLAUDE}/projects/-home-fixture-app/${ID}.jsonl`,
				`${CLAUDE}/projects/-home-fixture-app/${ID}/subagents/agent-1.jsonl`,
				`${CLAUDE}/projects/-home-fixture-app/other.jsonl`,
				`${CLAUDE}/projects/-home-fixture-lib/keep.jsonl`,
			],
		});
		const what = { kind: "claude", conversationId: ID } as const;

		await expect(r.run({ target: HOST, what })).resolves.toBe("deleted");
		expect([...r.files].sort()).toEqual([
			`${CLAUDE}/projects/-home-fixture-app/other.jsonl`,
			`${CLAUDE}/projects/-home-fixture-lib/keep.jsonl`,
		]);
		await expect(r.run({ target: HOST, what })).resolves.toBe("gone");
	});

	it("closes the pane before it deletes a conversation or a thread", async () => {
		const r = rig({ files: [`${CLAUDE}/projects/-home-fixture-app/${ID}.jsonl`] });

		await r.run({ target: HOST, what: { kind: "claude", conversationId: ID }, pane: PANE });
		await r.run({ target: HOST, what: { kind: "thread", backend: "codex", threadId: "thread-1" }, pane: PANE });

		expect(r.log).toEqual([
			"close work",
			`remove .claude/projects/-home-fixture-app/${ID}.jsonl`,
			"close work",
			"thread codex thread-1",
		]);
	});

	it("deletes a session's own files behind its pane's close", async () => {
		const r = rig({
			files: [
				`${HOME}/.config/switchboard/session-capabilities/host.work.json`,
				`${HOME}/.cache/switchboard/launch/host.work.json`,
				`${HOME}/.cache/switchboard/launch/host.other.json`,
			],
		});
		const what = { kind: "files", session: PANE } as const;

		await expect(r.run({ target: HOST, what, pane: PANE })).resolves.toBe("deleted");
		expect(r.log[0]).toBe("close work");
		expect([...r.files]).toEqual([`${HOME}/.cache/switchboard/launch/host.other.json`]);
		await expect(r.run({ target: HOST, what })).resolves.toBe("gone");
	});

	it("looks in the home of the spawn point a host session ran at, and waits while that home is out of reach", async () => {
		const win = "/mnt/c/Users/fixture";
		const pane: TmuxTarget = { kind: "host", name: "windows", sessionName: "work" };
		const held = [
			`${win}/.claude/projects/C--Users-fixture-app/${ID}.jsonl`,
			`${win}/.config/switchboard/session-capabilities/windows.work.json`,
			`${CLAUDE}/projects/-home-fixture-app/${ID}.jsonl`,
		];
		const conversation = { kind: "claude", conversationId: ID } as const;
		const files = { kind: "files", session: pane } as const;
		const reached = rig({ files: held, windows: win });
		const away = rig({ files: held });
		const unmounted = rig({ windows: win, unmounted: true });

		await expect(reached.run({ target: HOST, what: conversation, hostSpawn: "windows" })).resolves.toBe("deleted");
		await expect(reached.run({ target: HOST, what: files, hostSpawn: "windows" })).resolves.toBe("deleted");
		expect([...reached.files]).toEqual([`${CLAUDE}/projects/-home-fixture-app/${ID}.jsonl`]);

		await expect(away.run({ target: HOST, what: conversation, hostSpawn: "windows", pane })).resolves.toBe(
			"place_down",
		);
		await expect(away.run({ target: HOST, what: files, hostSpawn: "windows" })).resolves.toBe("place_down");
		expect(away.log).toEqual([]);
		expect(away.files.size).toBe(3);
		// A home that is not there is never read as holding nothing.
		await expect(unmounted.run({ target: HOST, what: conversation, hostSpawn: "windows" })).resolves.toBe(
			"place_down",
		);
	});

	it("answers place down for a container that is not running, and touches nothing", async () => {
		const r = rig({ down: true });

		const outcome = await r.run({
			target: BOX,
			what: { kind: "thread", backend: "opencode", threadId: "ses_sb1" },
			pane: { kind: "devcontainer", name: "recipe-app", sessionName: "work" },
		});

		expect(outcome).toBe("place_down");
		expect(r.log).toEqual(["exec devcontainer true"]);
	});

	it("fails, and never reads gone, in a container whose home is elsewhere, and still deletes a thread there", async () => {
		const r = rig({
			exec: (argv) => {
				if (argv[0] === "test") throw new Error("exit status 1");
				return "";
			},
		});

		await expect(r.run({ target: BOX, what: { kind: "claude", conversationId: ID } })).rejects.toThrow();
		await expect(
			r.run({ target: BOX, what: { kind: "thread", backend: "codex", threadId: "thread-1" } }),
		).resolves.toBe("deleted");
	});

	it("removes exactly its own things inside a container, run by a real shell", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-box-"));
		const write = (file: string) => {
			fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
			fs.writeFileSync(path.join(home, file), "x");
		};
		const boxed = { kind: "devcontainer", name: "recipe-app", sessionName: "work" } as const;
		const own = ownSessionFiles("recipe-app.work");
		const other = "123e4567-e89b-42d3-a456-426614174999";
		for (const file of [
			`.claude/projects/app/${ID}.jsonl`,
			`.claude/projects/app/${ID}/side.json`,
			`.claude/projects/app/${other}.jsonl`,
			`.claude/${ID}.jsonl`,
			...own,
		])
			write(file);
		const r = rig({
			exec: (argv) =>
				execFileSync(
					argv[0] as string,
					argv.slice(1).map((arg) => arg.replaceAll(CONTAINER_HOME, home)),
					{ encoding: "utf8" },
				),
		});
		try {
			for (const what of [
				{ kind: "claude", conversationId: ID } as const,
				{ kind: "files", session: boxed } as const,
			]) {
				await expect(r.run({ target: BOX, what })).resolves.toBe("deleted");
				await expect(r.run({ target: BOX, what })).resolves.toBe("gone");
			}
			const left = fs
				.readdirSync(home, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile());
			expect(left.map((entry) => entry.name).sort()).toEqual([`${ID}.jsonl`, `${other}.jsonl`]);

			// Root removes from a read-only folder, so only another user sees the refusal.
			if (process.getuid?.() !== 0) {
				write(own[0] as string);
				fs.chmodSync(path.dirname(path.join(home, own[0] as string)), 0o555);
				await expect(r.run({ target: BOX, what: { kind: "files", session: boxed } })).rejects.toThrow();
			}
		} finally {
			for (const file of own) fs.chmodSync(path.dirname(path.join(home, file)), 0o755);
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses an id that is no conversation id before it becomes a file name", () => {
		const op = { kind: "purge", target: HOST, what: { kind: "claude", conversationId: "../../etc" } };

		expect(HostPurgeOpSchema.safeParse(op).success).toBe(false);
	});
});
