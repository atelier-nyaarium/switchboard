// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { isCheckIn, type Routine, RoutineSchema, routineRefusal, targetKind } from "../../shared/schemasRoutine.js";
import { REVISION_CEILING, type Runbook } from "../../shared/schemasRunbook.js";
import type { SessionHarness } from "../../shared/session-harness.js";
import { renderRoutine } from "./render.js";
import { type TargetFacts, targetRules } from "./reservation.js";

export interface RoutineStoreDeps extends TargetFacts {
	/** Opened through `openDurable`. */
	store: DurableStore;
	/** The record cannot check itself against a runbook it cannot see. */
	getRunbook?: (runbookId: string) => Runbook | null;
	now: () => number;
	/** Opaque; never a time or an order. */
	newIncarnation: () => string;
	/** Required; fires after every landed write. */
	onChanged: () => void;
}

export interface RoutinePutResult {
	stored: boolean;
	revision: number;
	/** What is now stored. */
	routine?: Routine;
	reason?: string;
}

export interface RoutinePutOptions {
	/** Absent means nothing was stored. */
	base?: number;
}

const RoutinesSchema = z.array(RoutineSchema);

/** What a routine ran before it could name its CLI. */
const LEGACY_PICK: SessionHarness = "claude";

/** A spawn routine with no pick ran Claude. */
const legacyPick = (target: Routine["target"]): boolean => target.cli === undefined && targetKind(target) === "spawn";

/** No pick keeps the held one; `unpicked` kept as asked. */
function keptPick(incoming: Routine["target"], held: Routine["target"] | undefined): Routine["target"] {
	if (incoming.cli !== undefined) return incoming;
	if (held?.cli) return { ...incoming, cli: held.cli };
	return legacyPick(incoming) ? { ...incoming, cli: LEGACY_PICK } : incoming;
}

/** Frozen copy. */
function frozen(routine: Routine): Routine {
	return Object.freeze({
		...routine,
		weekdays: Object.freeze([...routine.weekdays].sort((a, b) => a - b)) as number[],
		values: Object.freeze({ ...routine.values }),
		target: Object.freeze({ ...routine.target }),
	});
}

/** Compares all but gateway-owned fields; a new owned field must join the exclusions. */
function sameContent(a: Routine, b: Routine): boolean {
	const owned = ({ revision: _revision, since: _since, incarnation: _incarnation, ...rest }: Routine) => rest;
	return canonicalJson(owned(a)) === canonicalJson(owned(b));
}

/** Refusals needing what only the gateway holds. */
function contextRefusal(routine: Routine, deps: RoutineStoreDeps): string | null {
	const target = targetRules(routine).refusal(routine, deps);
	if (target) return target;
	if (!deps.getRunbook) return null;
	const rendered = renderRoutine(deps.getRunbook(routine.runbookId), routine);
	return rendered.ok ? null : rendered.reason;
}

export function createRoutineStore(deps: RoutineStoreDeps) {
	const { store } = deps;
	let routines: Routine[] = RoutinesSchema.parse(store.load() ?? []).map(frozen);
	if (routines.some((routine) => legacyPick(routine.target))) {
		const picked = routines.map((routine) =>
			legacyPick(routine.target)
				? frozen({ ...routine, target: { ...routine.target, cli: LEGACY_PICK } })
				: routine,
		);
		commitChecked(
			store,
			picked,
			(landed) => {
				routines = landed;
			},
			{ label: "routine" },
		);
	}
	// Legacy routines get an incarnation before anything runs.
	if (routines.some((routine) => routine.incarnation === undefined)) {
		const minted = routines.map((routine) =>
			routine.incarnation === undefined ? frozen({ ...routine, incarnation: deps.newIncarnation() }) : routine,
		);
		commitChecked(
			store,
			minted,
			(landed) => {
				routines = landed;
			},
			{ label: "routine" },
		);
	}

	/** Disk first. */
	const commit = (next: Routine[]): boolean =>
		commitChecked(
			store,
			next,
			(landed) => {
				routines = landed;
			},
			{ label: "routine", onLanded: deps.onChanged },
		).landed;

	const held = (id: string): Routine | undefined => routines.find((routine) => routine.id === id);

	const list = (): Routine[] =>
		[...routines].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): Routine | null => held(id) ?? null;

	const put = (incoming: Routine, options: RoutinePutOptions = {}): RoutinePutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		// A kindless put would downgrade a check-in.
		if (current && isCheckIn(current) && incoming.target.kind === undefined) {
			return { stored: false, revision: held0, reason: "this routine is a check-in; update the app to edit it" };
		}
		const candidate = frozen({ ...incoming, target: keptPick(incoming.target, current?.target) });
		// Disabling needs no run context.
		const disablesOnly =
			current !== undefined && !candidate.enabled && sameContent(candidate, { ...current, enabled: false });
		const refusal = routineRefusal(incoming) ?? (disablesOnly ? null : contextRefusal(incoming, deps));
		if (refusal) return { stored: false, revision: held0, reason: refusal };
		if (current) {
			// A repeat is a lost answer.
			const echoesFirst = options.base === undefined && current.revision === 1;
			const echoesEdit = options.base === current.revision || options.base === current.revision - 1;
			if ((echoesFirst || echoesEdit) && sameContent(candidate, current)) {
				return { stored: true, revision: current.revision, routine: current };
			}
			if (options.base !== current.revision) {
				return {
					stored: false,
					revision: current.revision,
					reason: `revision ${current.revision} is stored; this edits ${options.base ?? "nothing"}`,
				};
			}
		}
		if (!current && options.base !== undefined) {
			return { stored: false, revision: 0, reason: "no routine with that id is stored" };
		}
		if (held0 >= REVISION_CEILING) {
			return { stored: false, revision: held0, reason: "this routine has no revision left to write" };
		}
		// Gateway-owned. Another target kind restarts the incarnation: history must not cross.
		const sameKind = current !== undefined && targetKind(current.target) === targetKind(candidate.target);
		const routine = frozen({
			...candidate,
			revision: held0 + 1,
			since: current?.since ?? deps.now(),
			incarnation: (sameKind ? current?.incarnation : undefined) ?? deps.newIncarnation(),
		});
		const next = current
			? routines.map((existing) => (existing.id === routine.id ? routine : existing))
			: [...routines, routine];
		if (!commit(next)) return { stored: false, revision: held0, reason: "could not be written" };
		return { stored: true, revision: routine.revision, routine };
	};

	/** Stale toggles are refused like a put. */
	const setEnabled = (id: string, enabled: boolean, base: number): RoutinePutResult => {
		const current = held(id);
		if (!current) return { stored: false, revision: 0, reason: "no routine with that id is stored" };
		if (base !== current.revision) {
			return {
				stored: false,
				revision: current.revision,
				reason: `revision ${current.revision} is stored; this edits ${base}`,
			};
		}
		if (current.enabled === enabled) return { stored: true, revision: current.revision, routine: current };
		return put({ ...current, enabled }, { base: current.revision });
	};

	const remove = (id: string): { deleted: boolean } => {
		const kept = routines.filter((routine) => routine.id !== id);
		if (kept.length === routines.length) return { deleted: false };
		return { deleted: commit(kept) };
	};

	return { list, get, put, setEnabled, remove };
}

export type RoutineStore = ReturnType<typeof createRoutineStore>;
