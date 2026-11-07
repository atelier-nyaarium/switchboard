// A Copilot compaction never shows whole on the pane; its events file says when one starts and ends.

import fs from "node:fs";
import path from "node:path";

const POLL_MS = 2_000;
/** Seeds the state at attach. */
const TAIL_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
/** A longer line carries nothing we read. */
const CARRY_MAX_BYTES = 1024 * 1024;

const COMPACTION_LINE = /^\{"type":"session\.compaction_(start|complete)"/;

////////////////////////////////
//  Interfaces & Types

export interface CompactionFollow {
	team: string;
	copilotSessionId: string;
}

export interface CompactionFollower {
	/** Replaces the followed set; a dropped team stops and reports nothing. */
	setFollows(entries: CompactionFollow[]): void;
	/** One read of every followed file. Also the test entry. */
	poll(): void;
	stop(): void;
}

interface FollowState {
	copilotSessionId: string;
	file: string;
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

function readRange(file: string, start: number, end: number): string {
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
}

function sizeOf(file: string): number | null {
	try {
		return fs.statSync(file).size;
	} catch {
		return null;
	}
}

export function createCompactionFollower(opts: {
	home: string;
	onChange: (team: string, compacting: boolean) => void;
	pollMs?: number;
}): CompactionFollower {
	const follows = new Map<string, FollowState>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const report = (team: string, state: FollowState, compacting: boolean): void => {
		if (state.compacting === compacting) return;
		state.compacting = compacting;
		opts.onChange(team, compacting);
	};

	/** Seeds from the tail, then follows appended bytes. */
	const attach = (team: string, copilotSessionId: string): void => {
		const file = compactionEventsPath(opts.home, copilotSessionId);
		const state: FollowState = { copilotSessionId, file, offset: 0, carry: "", compacting: false };
		follows.set(team, state);
		const size = sizeOf(file);
		if (size === null) return;
		const start = Math.max(0, size - TAIL_BYTES);
		const tail = readRange(file, start, size);
		// A cut first line is noise.
		const whole = start > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail;
		state.offset = size;
		report(team, state, compactionAfter(whole, false));
	};

	const pollOne = (team: string, state: FollowState): void => {
		const size = sizeOf(state.file);
		if (size === null) {
			state.offset = 0;
			state.carry = "";
			report(team, state, false);
			return;
		}
		if (size < state.offset) {
			// Rotated or truncated.
			state.offset = 0;
			state.carry = "";
			report(team, state, false);
		}
		if (size === state.offset) return;
		const text = state.carry + readRange(state.file, state.offset, size);
		state.offset = size;
		const cut = text.lastIndexOf("\n");
		const complete = cut < 0 ? "" : text.slice(0, cut + 1);
		state.carry = cut < 0 ? text : text.slice(cut + 1);
		if (state.carry.length > CARRY_MAX_BYTES) state.carry = "";
		report(team, state, compactionAfter(complete, state.compacting));
	};

	const poll = (): void => {
		for (const [team, state] of follows) {
			try {
				pollOne(team, state);
			} catch {
				// Unreadable now; the next poll reads again.
			}
		}
	};

	return {
		setFollows(entries) {
			const next = new Map(entries.map((entry) => [entry.team, entry.copilotSessionId]));
			for (const [team, state] of follows) {
				if (next.get(team) !== state.copilotSessionId) follows.delete(team);
			}
			for (const [team, copilotSessionId] of next) {
				if (!follows.has(team)) attach(team, copilotSessionId);
			}
			if (follows.size > 0 && timer === undefined) {
				timer = setInterval(poll, opts.pollMs ?? POLL_MS);
				timer.unref?.();
			}
			if (follows.size === 0 && timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		},
		poll,
		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			follows.clear();
		},
	};
}
