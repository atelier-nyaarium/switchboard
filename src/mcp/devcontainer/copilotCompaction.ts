// A Copilot compaction never shows whole on the pane; its events file says when one starts and ends.

import fs from "node:fs";
import path from "node:path";
import type { TmuxTarget } from "../../shared/host-op.js";

const POLL_MS = 2_000;
/** Seeds the state at attach. */
const TAIL_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
/** Per poll. */
const POLL_READ_BYTES = 192 * 1024;
/** A longer line carries nothing we read. */
const CARRY_MAX_BYTES = 1024 * 1024;

const COMPACTION_LINE = /^\{"type":"session\.compaction_(start|complete)"/;

////////////////////////////////
//  Interfaces & Types

export interface CompactionFollow {
	team: string;
	copilotSessionId: string;
	/** Where the session runs. */
	place: Pick<TmuxTarget, "kind" | "name">;
}

/** One session's events file. */
export interface EventsFile {
	/** Null while absent or unreadable. */
	size(): Promise<number | null>;
	/** The bytes in [start, end). */
	read(start: number, end: number): Promise<string>;
}

export interface CompactionFollower {
	/** Replaces the followed set. */
	setFollows(entries: CompactionFollow[]): Promise<void>;
	/** One read of every followed file. Also the test entry. */
	poll(): Promise<void>;
	stop(): void;
}

interface FollowState {
	follow: CompactionFollow;
	file: EventsFile;
	/** Seeded from the tail. */
	attached: boolean;
	/** Absent or cut; reseed next read. */
	reset: boolean;
	offset: number;
	carry: string;
	compacting: boolean;
}

////////////////////////////////
//  Functions & Helpers

export function compactionEventsPath(home: string, copilotSessionId: string): string {
	return path.join(home, ".copilot", "session-state", copilotSessionId, "events.jsonl");
}

/** What the last compaction line in `text` says, if any. */
export function compactionAfter(text: string, current: boolean): boolean {
	let state = current;
	for (const line of text.split("\n")) {
		const match = COMPACTION_LINE.exec(line);
		if (match) state = match[1] === "start";
	}
	return state;
}

/** A file on this machine. */
export function localEventsFile(file: string): EventsFile {
	return {
		size: async () => {
			try {
				return fs.statSync(file).size;
			} catch {
				return null;
			}
		},
		read: async (start, end) => {
			const fd = fs.openSync(file, "r");
			try {
				const parts: Buffer[] = [];
				let at = start;
				while (at < end) {
					const length = Math.min(READ_CHUNK_BYTES, end - at);
					const buffer = Buffer.alloc(length);
					const read = fs.readSync(fd, buffer, 0, length, at);
					if (read <= 0) break;
					parts.push(buffer.subarray(0, read));
					at += read;
				}
				return Buffer.concat(parts).toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		},
	};
}

/** A file read where it lives; only absence is null. */
export function execEventsFile(exec: (argv: string[]) => Promise<string>, file: string): EventsFile {
	return {
		size: async () => {
			const said = (
				await exec(["sh", "-c", 'if [ -e "$1" ]; then stat -c %s "$1"; else echo absent; fi', "sh", file])
			).trim();
			if (said === "absent") return null;
			if (!/^\d+$/.test(said)) throw new Error(`unreadable size for ${file}`);
			return Number(said);
		},
		// One process: a failed read fails.
		read: (start, end) =>
			exec([
				"dd",
				`if=${file}`,
				"iflag=skip_bytes,count_bytes",
				`skip=${start}`,
				`count=${end - start}`,
				"status=none",
			]),
	};
}

export function createCompactionFollower(opts: {
	/** The file's port, per place. */
	file: (follow: CompactionFollow) => EventsFile;
	onChange: (team: string, compacting: boolean) => void;
	pollMs?: number;
}): CompactionFollower {
	const follows = new Map<string, FollowState>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let polling: Promise<void> | undefined;

	const report = (team: string, state: FollowState, compacting: boolean): void => {
		if (state.compacting === compacting || follows.get(team) !== state) return;
		state.compacting = compacting;
		opts.onChange(team, compacting);
	};

	/** Seeds from the tail, then follows. */
	const seed = async (state: FollowState, size: number): Promise<void> => {
		const start = Math.max(0, size - TAIL_BYTES);
		const tail = await state.file.read(start, size);
		// A cut first line is noise.
		const whole = start > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail;
		state.offset = size;
		state.carry = "";
		state.reset = false;
		report(state.follow.team, state, compactionAfter(whole, false));
	};

	const attach = async (state: FollowState): Promise<void> => {
		const size = await state.file.size();
		if (size === null) state.reset = true;
		else await seed(state, size);
		state.attached = true;
	};

	// A failed read holds the offset.
	const pollOne = async (team: string, state: FollowState): Promise<void> => {
		const size = await state.file.size();
		if (size === null) {
			state.reset = true;
			report(team, state, false);
			return;
		}
		// Back, rotated or truncated.
		if (state.reset || size < state.offset) {
			await seed(state, size);
			return;
		}
		if (size === state.offset) return;
		const end = Math.min(size, state.offset + POLL_READ_BYTES);
		const text = state.carry + (await state.file.read(state.offset, end));
		state.offset = end;
		const cut = text.lastIndexOf("\n");
		const complete = cut < 0 ? "" : text.slice(0, cut + 1);
		state.carry = cut < 0 ? text : text.slice(cut + 1);
		if (state.carry.length > CARRY_MAX_BYTES) state.carry = "";
		report(team, state, compactionAfter(complete, state.compacting));
	};

	const pollAll = async (): Promise<void> => {
		for (const [team, state] of [...follows]) {
			if (!state.attached) continue;
			try {
				await pollOne(team, state);
			} catch {
				// Unreadable now; the next poll reads again.
			}
		}
	};

	// One poll at a time.
	const poll = (): Promise<void> => {
		polling ??= pollAll().finally(() => {
			polling = undefined;
		});
		return polling;
	};

	return {
		async setFollows(entries) {
			const next = new Map(entries.map((entry) => [entry.team, entry]));
			for (const [team, state] of follows) {
				if (next.get(team)?.copilotSessionId === state.follow.copilotSessionId) continue;
				follows.delete(team);
				// A dropped follow must end.
				if (state.compacting) opts.onChange(team, false);
			}
			const attaching: Promise<void>[] = [];
			for (const [team, follow] of next) {
				if (follows.has(team)) continue;
				const state: FollowState = {
					follow,
					file: opts.file(follow),
					attached: false,
					reset: false,
					offset: 0,
					carry: "",
					compacting: false,
				};
				follows.set(team, state);
				attaching.push(
					attach(state).catch(() => {
						// Unreadable now; the next poll reseeds.
						state.reset = true;
						state.attached = true;
					}),
				);
			}
			if (follows.size > 0 && timer === undefined) {
				timer = setInterval(() => {
					poll().catch(() => undefined);
				}, opts.pollMs ?? POLL_MS);
				timer.unref?.();
			}
			if (follows.size === 0 && timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			await Promise.all(attaching);
		},
		poll,
		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			follows.clear();
		},
	};
}
