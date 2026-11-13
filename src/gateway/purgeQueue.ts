// Keep deletions until their place can delete them.

import { z } from "zod";
import { type AgentExecutionTarget, AgentExecutionTargetSchema } from "../shared/agent-execution-target.js";
import type { Ambient, TimerHandle } from "../shared/ambient.js";
import {
	type HostOp,
	type HostOpResult,
	type HostPurgeOp,
	HostPurgeOpSchema,
	HostPurgeResultSchema,
	type TmuxTarget,
} from "../shared/host-op.js";
import { HOST_SPAWN } from "../shared/host-spawn.js";
import type { PurgeHolds } from "./purgeHolds.js";

////////////////////////////////
//  Interfaces & Types

const HostPlace = AgentExecutionTargetSchema.options[0].extend({ spawn: z.string().min(1).max(64).optional() });
const ContainerPlace = AgentExecutionTargetSchema.options[1].omit({ hostProjectPath: true });
const PurgePlaceSchema = z.discriminatedUnion("kind", [HostPlace, ContainerPlace]);

/** A container resolves by project at deletion. A host place names its spawn point. */
export type PurgePlace = z.infer<typeof PurgePlaceSchema>;

export interface PurgeItem {
	place: PurgePlace;
	what: HostPurgeOp["what"];
	/** Closed first. */
	pane?: TmuxTarget;
	/** Queued by a workflow run's 7 day removal. A delete that finds data is counted. */
	backstop?: true;
}

export interface PurgeEntry extends PurgeItem {
	queuedAt: number;
}

/** What 7 day removals still found, where the step-end and 24 hour rules should have left nothing. */
export interface BackstopTally {
	found: number;
	lastAt: number | null;
}

export interface PurgeDrainDeps {
	relay(op: HostOp): Promise<HostOpResult>;
	hostLive(): boolean;
	/** What live state still holds of an entry. */
	holds(entry: PurgeItem): PurgeHolds;
	/** Undefined until daemon names the container. */
	targetOf(place: PurgePlace): AgentExecutionTarget | undefined;
}

export interface PurgeQueue {
	/** Persist with removal; drain after caller returns. Answers the items newly queued. */
	add(items: readonly PurgeItem[]): PurgeItem[];
	/** Undoes an `add`; takes its answer. */
	withdraw(items: readonly PurgeItem[]): void;
	snapshot(): PurgeEntry[];
	/** Drop invalid entries. */
	restore(raw: unknown): void;
	size(): number;
	start(deps: PurgeDrainDeps): void;
	/** Retry when a place returns. */
	kick(): void;
	stop(): void;
	/** Wait for the active pass. */
	idle(): Promise<void>;
	/** Counts what a 7 day removal found by other means. */
	found(count: number, what: string): void;
	tally(): BackstopTally;
	restoreTally(raw: unknown): void;
}

////////////////////////////////
//  Constants

export const PURGE_ENTRY_TTL_MS = 30 * 24 * 60 * 60_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

const PurgeEntrySchema = HostPurgeOpSchema.omit({ kind: true, target: true, hostSpawn: true })
	.extend({
		place: PurgePlaceSchema,
		queuedAt: z.number().int().nonnegative(),
		backstop: z.literal(true).optional(),
	})
	.strict();

const BackstopTallySchema = z.object({
	found: z.number().int().nonnegative(),
	lastAt: z.number().int().nonnegative().nullable(),
});

////////////////////////////////
//  Functions & Helpers

function placeKey(entry: PurgeItem): string {
	return entry.place.kind === "host" ? `host:${entry.place.spawn ?? HOST_SPAWN}` : `container:${entry.place.project}`;
}

/** Where an agent or a workflow step ran. */
export function purgePlaceOf(target: AgentExecutionTarget): PurgePlace {
	return target.kind === "host" ? target : { kind: "devcontainer", project: target.project };
}

/** One per item and place. */
function keyOf(entry: PurgeItem): string {
	return `${placeKey(entry)} ${JSON.stringify(entry.what)}`;
}

export function createPurgeQueue(ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">): PurgeQueue {
	const entries = new Map<string, PurgeEntry>();
	let deps: PurgeDrainDeps | undefined;
	let stopped = false;
	let running: Promise<void> | undefined;
	let again = false;
	let timer: TimerHandle | undefined;
	let delay = RETRY_MIN_MS;
	let tally: BackstopTally = { found: 0, lastAt: null };

	/** Last failure per entry. */
	const complaints = new Map<string, string>();

	/** Once per entry and cause. */
	const complain = (entry: PurgeEntry, cause: string): void => {
		const key = keyOf(entry);
		if (complaints.get(key) === cause) return;
		complaints.set(key, cause);
		console.warn(`[purge] ${entry.what.kind} at ${placeKey(entry)} was not deleted: ${cause}`);
	};

	const retire = (key: string): void => {
		entries.delete(key);
		complaints.delete(key);
	};

	const found = (count: number, what: string): void => {
		if (count <= 0) return;
		tally = { found: tally.found + count, lastAt: ambient.now() };
		console.warn(`[purge] a 7 day removal found ${count} ${what}`);
	};

	const arm = (): void => {
		if (timer !== undefined) ambient.clearTimer(timer);
		timer = undefined;
		if (stopped || entries.size === 0) return;
		timer = ambient.setTimer(() => {
			timer = undefined;
			run();
		}, delay);
	};

	/** True means done. "host" means no daemon to ask. */
	const drainOne = async (entry: PurgeEntry, held: PurgeDrainDeps): Promise<boolean | "down" | "host"> => {
		const holds = held.holds(entry);
		// Left to whoever holds it.
		if (holds.conversation === true) return true;
		if (entry.what.kind === "files" && holds.files) return true;
		// May still register under this conversation.
		if (holds.conversation === "unknown") return false;
		const target = held.targetOf(entry.place);
		if (!target) return "down";
		const pane = entry.pane && !holds.pane ? { pane: entry.pane } : {};
		const hostSpawn = entry.place.kind === "host" && entry.place.spawn ? { hostSpawn: entry.place.spawn } : {};
		const answer = await held.relay({ kind: "purge", target, what: entry.what, ...pane, ...hostSpawn });
		if (!answer.ok) {
			if (answer.errorKind === "disconnected" || !held.hostLive()) return "host";
			complain(entry, answer.error ?? answer.errorKind ?? "the daemon refused");
			return false;
		}
		// Unknown results stay queued.
		const result = HostPurgeResultSchema.safeParse(answer.result);
		if (!result.success) {
			complain(entry, "the daemon's answer could not be read");
			return false;
		}
		if (entry.backstop && result.data.outcome === "deleted") found(1, `${entry.what.kind} still at its place`);
		return result.data.outcome === "place_down" ? "down" : true;
	};

	const pass = async (held: PurgeDrainDeps): Promise<boolean> => {
		const cutoff = ambient.now() - PURGE_ENTRY_TTL_MS;
		for (const [key, entry] of entries) {
			if (entry.queuedAt >= cutoff) continue;
			console.warn(`[purge] gave up on ${entry.what.kind} at ${placeKey(entry)} after 30 days`);
			retire(key);
		}
		const down = new Set<string>();
		let progress = false;
		for (const [key, entry] of [...entries]) {
			if (stopped || !held.hostLive()) break;
			if (entries.get(key) !== entry || down.has(placeKey(entry))) continue;
			let outcome: boolean | "down" | "host";
			try {
				outcome = await drainOne(entry, held);
			} catch (error) {
				complain(entry, error instanceof Error ? error.message : String(error));
				outcome = false;
			}
			if (outcome === "host") break;
			if (outcome === "down") down.add(placeKey(entry));
			if (outcome !== true) continue;
			if (entries.get(key) === entry) retire(key);
			progress = true;
		}
		return progress;
	};

	function run(): void {
		const held = deps;
		if (!held || stopped) return;
		if (running) {
			again = true;
			return;
		}
		running = pass(held)
			.then(
				(progress) => {
					delay = progress ? RETRY_MIN_MS : Math.min(delay * 2, RETRY_MAX_MS);
				},
				() => undefined,
			)
			.finally(() => {
				running = undefined;
				if (again) {
					again = false;
					run();
				} else arm();
			});
	}

	const kick = (): void => {
		delay = RETRY_MIN_MS;
		run();
	};

	return {
		add(items) {
			const now = ambient.now();
			const queued: PurgeItem[] = [];
			for (const item of items) {
				const key = keyOf(item);
				const held = entries.get(key);
				if (held) {
					// A waiting miss still counts.
					if (item.backstop) held.backstop = true;
					continue;
				}
				entries.set(key, { ...item, queuedAt: now });
				queued.push(item);
			}
			// Drain after caller returns.
			if (items.length > 0) queueMicrotask(kick);
			return queued;
		},
		withdraw(items) {
			for (const item of items) retire(keyOf(item));
		},
		snapshot: () => [...entries.values()],
		restore(raw) {
			if (!Array.isArray(raw)) return;
			for (const candidate of raw) {
				const parsed = PurgeEntrySchema.safeParse(candidate);
				if (parsed.success) entries.set(keyOf(parsed.data), parsed.data);
			}
		},
		size: () => entries.size,
		start(held) {
			deps = held;
			kick();
		},
		kick,
		stop() {
			stopped = true;
			if (timer !== undefined) ambient.clearTimer(timer);
			timer = undefined;
		},
		idle: async () => {
			await Promise.resolve();
			while (running) await running;
		},
		found,
		tally: () => ({ ...tally }),
		restoreTally(raw) {
			const parsed = BackstopTallySchema.safeParse(raw);
			if (parsed.success) tally = parsed.data;
		},
	};
}
