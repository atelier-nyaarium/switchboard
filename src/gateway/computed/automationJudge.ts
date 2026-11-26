// Every automation write, judged once.

import { type Reached, reached, written } from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import {
	AUTOMATION_ACTIONS,
	type Automation,
	type AutomationAction,
	type AutomationActionKind,
	type AutomationInput,
	AutomationSchema,
	type CarriedAutomation,
	type CarriedFunction,
	canonicalAutomation,
} from "../../shared/schemasAutomation.js";
import { type AutomationSaveRefusal, SAVE_LINE_MAX } from "../../shared/schemasAutomationSave.js";
import { type AutomationFunction, FunctionSchema } from "../../shared/schemasFunction.js";
import type { OwnerRecord, OwnerWrite } from "../ownerRecords.js";
import { type CallIssue, NO_SWITCH } from "./automationValidity.js";

type RunFunction = Extract<AutomationAction, { kind: "run_function" }>;

export const AUTOMATION_KIND = "automation";
export const FUNCTION_KIND = "function";

export const NOT_HOME = "the assistant does not live on this Gateway";

export type SavedFunction =
	| { as: "edit"; id: string; body: unknown; base: number }
	| { as: "copy"; from: string; fromBase: number; body: unknown };

export type AutomationIntent =
	| { kind: "owner_put"; id: string; body: unknown; base: number; confirmed?: boolean }
	| {
			kind: "save";
			id: string;
			body: unknown;
			base: number;
			function?: SavedFunction;
			/** Its function's shown revision. */
			functionBase?: number;
			confirmed?: boolean;
	  }
	| { kind: "owner_remove"; id: string; base: number }
	/** Null functions: older phone. */
	| { kind: "carry"; rows: readonly CarriedAutomation[]; functions: readonly CarriedFunction[] | null }
	| { kind: "sweep"; ids: readonly string[] }
	// Remove 2026-11-28 with the stored rules.
	| { kind: "adoption"; rows: readonly CarriedAutomation[] }
	// Remove 2027-01-15 with the stored thresholds.
	/** One sensor's stored alerts, as plain automations. */
	| { kind: "conversion"; prefix: string; rows: ReadonlyMap<string, Automation> };

export interface AutomationJudgeView {
	/** Readable rows. */
	held: readonly OwnerRecord<Automation>[];
	functions: readonly OwnerRecord<AutomationFunction>[];
	/** Automation rows this build cannot read. */
	unreadAutomations: number;
	isHome: boolean;
	/** Why this Gateway cannot run it. */
	issue: (body: Automation) => string | null;
	/** Fit and the switches its values name. */
	callIssue: (body: Automation, fn: AutomationFunction) => CallIssue | null;
	/** Its first step issue. */
	functionIssue: (fn: AutomationFunction) => string | null;
	/** Null without a key. */
	copyIdOf: (automationId: string, from: string) => string | null;
	/** Null without a key. */
	carryIdOf: (from: string) => string | null;
	/** A row this build cannot read holds it. */
	unreadAt: (id: string) => boolean;
}

export interface DroppedAutomation {
	id: string;
	reason: string;
}

export type AutomationVerdict =
	/** `confirm` names the actions a save must confirm. */
	| { kind: "refused"; reason: string; refusal: AutomationSaveRefusal; confirm?: string[] }
	| { kind: "writes"; writes: OwnerWrite[]; dropped: DroppedAutomation[] };

/** Leaves and arrives with the assistant. */
export const movesWithHome = (body: Automation): boolean => body.trigger.kind === "event";

const refused = (reason: string, refusal: AutomationSaveRefusal): AutomationVerdict => ({
	kind: "refused",
	reason,
	refusal: refusal.line === undefined ? { ...refusal, line: reason.slice(0, SAVE_LINE_MAX) } : refusal,
});

const put = (id: string, body: unknown, base: number, revive = false, unfit = false): OwnerWrite => ({
	op: "put",
	kind: AUTOMATION_KIND,
	id,
	body,
	base,
	...(revive ? { revive } : {}),
	...(unfit ? { unfit } : {}),
});

const putFunction = (
	id: string,
	body: AutomationFunction,
	base: number,
	options: { revive?: true; unfit?: true } = {},
): OwnerWrite => ({ op: "put", kind: FUNCTION_KIND, id, body, base, ...options });

const remove = ({ id, revision }: { id: string; revision: number }): OwnerWrite => ({
	op: "remove",
	id,
	base: revision,
});

export const pointerOf = (body: Automation): RunFunction | null =>
	written(body).find((action): action is RunFunction => action.kind === "run_function") ?? null;

const onlyEnabledMoved = (next: Automation, held: Automation | undefined): boolean =>
	held !== undefined && canonicalJson({ ...next, enabled: true }) === canonicalJson({ ...held, enabled: true });

/** One key for an action, flat or as a step. */
const dangerKey = (at: Reached): string | null => {
	if (!stepDanger(at.kind)) return null;
	if ("action" in at) return canonicalJson(at.action);
	const values = Object.entries(at.step.args).map(([name, arg]) => [
		name,
		arg.kind === "literal" ? arg.value : { expression: arg.text },
	]);
	return canonicalJson({ kind: at.kind, ...Object.fromEntries(values) });
};

const stepDanger = (kind: string): boolean =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) && AUTOMATION_ACTIONS[kind as AutomationActionKind].danger;

const labelOf = (kind: string): string =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) ? AUTOMATION_ACTIONS[kind as AutomationActionKind].label : kind;

/** New dangerous actions; for an event user, all new reach. */
function asksOf(next: Reached[], held: Reached[] | null, event: boolean, heldWasEvent: boolean): string[] {
	const known = new Set((held ?? []).map(dangerKey).filter((key) => key !== null));
	const danger = next.filter((at) => {
		const key = dangerKey(at);
		return key !== null && !known.has(key);
	});
	const prior = (held ?? []).filter((at) => !("action" in at && at.action.kind === "run_function"));
	const toldOnly = !heldWasEvent || prior.every((at) => at.kind === "tell_assistant");
	const reach = event && toldOnly ? next.filter((at) => at.kind !== "tell_assistant") : [];
	return [...danger, ...reach].map((at) => labelOf(at.kind));
}

function judgeSave(
	intent: Extract<AutomationIntent, { kind: "owner_put" | "save" }>,
	view: AutomationJudgeView,
): AutomationVerdict {
	const heldAt = (id: string) => view.held.find((record) => record.id === id);
	const functionAt = (id: string) => view.functions.find((record) => record.id === id);
	const parsed = AutomationSchema.safeParse(intent.body);
	if (!parsed.success) return { kind: "writes", writes: [put(intent.id, intent.body, intent.base)], dropped: [] };
	// One id space across kinds.
	if (functionAt(intent.id))
		return refused("a function holds that id", { code: "invalid", record: "automation", id: intent.id });
	const held = heldAt(intent.id);
	let next = canonicalAutomation(parsed.data);
	const actions = written(next);
	if (actions.some((action) => action.kind === "run_function") && actions.length > 1)
		return refused("a function runs alone", { code: "mixed", record: "automation" });
	const heldPointer = held ? pointerOf(held.body) : null;
	if (intent.kind === "owner_put" && heldPointer && !pointerOf(next))
		return refused("edit this in the newer app", { code: "newer_app", record: "automation" });

	let fnWrite: { id: string; body: AutomationFunction; base: number; revive?: true } | null = null;
	const sent = intent.kind === "save" ? intent.function : undefined;
	if (sent) {
		const body = FunctionSchema.safeParse(sent.body);
		if (!body.success) {
			const path = body.error.issues[0]?.path.join(".") ?? "";
			return refused("the function is invalid", { code: "invalid", record: "function", path });
		}
		if (sent.as === "copy") {
			const pointer = pointerOf(next);
			if (!pointer) return refused("a copy needs a pointer", { code: "invalid", record: "automation" });
			const start = view.copyIdOf(intent.id, sent.from);
			if (start === null) return claimRefusal({ refused: "no_key" });
			const step = (at: string) => view.copyIdOf(intent.id, at);
			const from = functionAt(sent.from);
			// A retry whose answer was lost.
			const echoed = from ? null : copyEchoOf(view, intent.id, start, step, body.data);
			let id: string;
			if (echoed) id = echoed;
			else {
				if (!from) return refused("the function is gone", { code: "gone", record: "function" });
				if (from.revision !== sent.fromBase) {
					return refused(`revision ${from.revision} is stored`, {
						code: "moved",
						record: "function",
						revision: from.revision,
					});
				}
				const claim = claimDerived(
					start,
					step,
					takeableBy(view, (user) => user === intent.id),
				);
				if ("refused" in claim) return claimRefusal(claim);
				id = claim.id;
			}
			next = AutomationSchema.parse({
				...next,
				actions: actions.map((action) => (action === pointer ? { ...pointer, function: id } : action)),
			} satisfies AutomationInput);
			fnWrite = { id, body: body.data, base: functionAt(id)?.revision ?? 0, revive: true };
		} else {
			if (pointerOf(next)?.function !== sent.id)
				return refused("the automation does not run it", { code: "invalid", record: "function" });
			if (sent.id === intent.id || heldAt(sent.id))
				return refused("an automation holds that id", { code: "invalid", record: "function", id: sent.id });
			fnWrite = { id: sent.id, body: body.data, base: sent.base };
		}
	}
	const pointer = pointerOf(next);
	if (pointer?.coolDownSec !== undefined && "coolDownSec" in next.trigger)
		return refused("its trigger cools down already", { code: "cool_down_twice", record: "automation" });
	const toggle = !sent && onlyEnabledMoved(next, held?.body);

	const functionNext = (id: string): AutomationFunction | null =>
		fnWrite?.id === id ? fnWrite.body : (functionAt(id)?.body ?? null);
	const functionHeld = (id: string): AutomationFunction | null => functionAt(id)?.body ?? null;
	if (!toggle && pointer && !functionNext(pointer.function)) {
		return view.unreadAt(pointer.function)
			? refused("a newer build wrote that function", {
					code: "newer_function",
					record: "function",
					id: pointer.function,
				})
			: refused("the function it runs is gone", { code: "unknown_function", id: pointer.function });
	}
	// The screen showed another body.
	if (!toggle && pointer && !sent && intent.kind === "save" && intent.functionBase !== undefined) {
		const shown = functionAt(pointer.function);
		if (shown && shown.revision !== intent.functionBase) {
			return refused(`revision ${shown.revision} is stored`, {
				code: "moved",
				record: "function",
				revision: shown.revision,
			});
		}
	}
	// Fresh pointers need sound functions.
	if (!toggle && pointer && pointer.function !== heldPointer?.function && fnWrite?.id !== pointer.function) {
		const stored = functionAt(pointer.function);
		const line = stored ? view.functionIssue(stored.body) : null;
		if (line) return refused(line, { code: "invalid", record: "function", id: pointer.function });
	}

	// Includes other users of an edited function.
	const users = [
		{ id: intent.id, body: next, held: held?.body ?? null },
		...(fnWrite
			? view.held
					.filter((record) => record.id !== intent.id && pointerOf(record.body)?.function === fnWrite?.id)
					.map((record) => ({ id: record.id, body: record.body, held: record.body }))
			: []),
	];

	if (!toggle) {
		const issueUnder = (body: Automation, functions: (id: string) => AutomationFunction | null) => {
			const at = pointerOf(body);
			const fn = at ? functions(at.function) : null;
			return fn ? view.callIssue(body, fn) : null;
		};
		/** Held users only fail on new reach. */
		const issueOf = (body: Automation, own: boolean) => {
			const after = issueUnder(body, functionNext);
			if (own || after === null) return after;
			const before = issueUnder(body, functionHeld);
			return before !== null && canonicalJson(before) === canonicalJson(after) ? null : after;
		};
		const own = issueOf(next, true);
		if (own?.kind === "switch") {
			return refused(NO_SWITCH, {
				code: "invalid",
				record: "automation",
				path: `values.${own.param}`,
				line: NO_SWITCH,
			});
		}
		const unfit = users.filter(({ id, body }) => issueOf(body, id === intent.id) !== null);
		if (unfit.length > 0) {
			return refused("it would stop fitting what runs it", {
				code: "unfit",
				automations: unfit.map((user) => user.id),
			});
		}
	}

	if (users.some(({ body }) => movesWithHome(body)) && !view.isHome) return refused(NOT_HOME, { code: "not_home" });

	if (!intent.confirmed) {
		const labels = users.flatMap(({ body, held: before }) =>
			asksOf(
				reached(body, functionNext),
				before ? reached(before, functionHeld) : null,
				movesWithHome(body),
				before?.trigger.kind === "event",
			),
		);
		if (labels.length > 0) {
			const confirm = [...new Set(labels)];
			return {
				kind: "refused",
				reason: "confirm what it does",
				refusal: { code: "confirm", labels: confirm, line: "confirm what it does" },
				confirm,
			};
		}
	}

	// The function lands first, so the automation's check sees it.
	const writes: OwnerWrite[] = fnWrite
		? [putFunction(fnWrite.id, fnWrite.body, fnWrite.base, fnWrite.revive ? { revive: true } : {})]
		: [];
	writes.push(put(intent.id, next, intent.base, false, toggle));
	return { kind: "writes", writes: [...writes, ...unused(view, intent.id, next)], dropped: [] };
}

/** Who runs a function; unknown while an unread automation is held. */
export function usersOf(
	view: Pick<AutomationJudgeView, "held" | "unreadAutomations">,
	id: string,
): readonly string[] | "unknown" {
	if (view.unreadAutomations > 0) return "unknown";
	return view.held.filter((record) => pointerOf(record.body)?.function === id).map((record) => record.id);
}

const DERIVED_HOPS = 8;

type Claim = { id: string } | { refused: "no_key" | "exhausted" };

/** The first id on a chain this intent may write. */
function claimDerived(start: string, next: (id: string) => string | null, takeable: (id: string) => boolean): Claim {
	let id: string | null = start;
	for (let hop = 0; hop < DERIVED_HOPS; hop++) {
		if (id === null) return { refused: "no_key" };
		if (takeable(id)) return { id };
		id = next(id);
	}
	return { refused: "exhausted" };
}

/** Absent, buried, or a function only `allowed` users run. */
function takeableBy(view: AutomationJudgeView, allowed: (user: string) => boolean) {
	return (id: string): boolean => {
		if (view.unreadAt(id) || view.held.some((record) => record.id === id)) return false;
		if (!view.functions.some((record) => record.id === id)) return true;
		const users = usersOf(view, id);
		return users !== "unknown" && users.every(allowed);
	};
}

/** The copy a held automation already runs, with this body. */
function copyEchoOf(
	view: AutomationJudgeView,
	automationId: string,
	start: string,
	next: (id: string) => string | null,
	body: AutomationFunction,
): string | null {
	const held = view.held.find((record) => record.id === automationId);
	const runs = held ? pointerOf(held.body)?.function : undefined;
	let id: string | null = start;
	for (let hop = 0; hop < DERIVED_HOPS && id !== null; hop++) {
		const copy = view.functions.find((record) => record.id === id);
		if (id === runs && copy && canonicalJson(copy.body) === canonicalJson(body)) return id;
		id = next(id);
	}
	return null;
}

const claimRefusal = (claim: Extract<Claim, { refused: string }>): AutomationVerdict =>
	claim.refused === "no_key"
		? refused("the key for derived ids cannot be read", { code: "no_key" })
		: refused("no derived id is free", { code: "no_free_id" });

function unused(view: AutomationJudgeView, id: string, next: Automation | null): OwnerWrite[] {
	const held = view.held.find((record) => record.id === id);
	const was = held ? pointerOf(held.body)?.function : undefined;
	if (was === undefined || (next && pointerOf(next)?.function === was)) return [];
	const users = usersOf(view, was);
	const fn = view.functions.find((record) => record.id === was);
	// Unknown means used.
	return users === "unknown" || users.some((user) => user !== id) || !fn ? [] : [remove(fn)];
}

/** Last of an id wins. */
function fitting(rows: readonly CarriedAutomation[], view: AutomationJudgeView, runnable: boolean) {
	const wanted = new Map<string, Automation>();
	const dropped: DroppedAutomation[] = [];
	for (const { id, automation } of rows) {
		const reason = !movesWithHome(automation)
			? "not an event automation"
			: runnable
				? view.issue(automation)
				: null;
		if (reason === null) wanted.set(id, canonicalAutomation(automation));
		else dropped.push({ id, reason });
	}
	return { wanted, dropped };
}

/** Never refused; unfit rows land invalid. */
function judgeCarry(
	intent: Extract<AutomationIntent, { kind: "carry" }>,
	view: AutomationJudgeView,
): AutomationVerdict {
	const heldAt = (id: string) => view.held.find((record) => record.id === id);
	const functionAt = (id: string) => view.functions.find((record) => record.id === id);
	// Kept invalid; nothing lost.
	const { wanted, dropped } = fitting(intent.rows, view, false);
	const leaving = view.held.filter((record) => movesWithHome(record.body) && !wanted.has(record.id));
	const moves = (user: string) => {
		const held = heldAt(user);
		return wanted.has(user) || (held !== undefined && movesWithHome(held.body));
	};
	const takeable = takeableBy(view, moves);
	/** A move in place keeps its own functions. */
	const inPlace = new Set(
		[...wanted.keys()].flatMap((id) => {
			const held = heldAt(id);
			const own = held && movesWithHome(held.body) ? pointerOf(held.body)?.function : undefined;
			return own && !view.unreadAt(own) ? [own] : [];
		}),
	);
	/** Landing id to its source. */
	const claimedBy = new Map<string, string>();
	const claimFor = (source: string): Claim =>
		inPlace.has(source)
			? { id: source }
			: claimDerived(source, view.carryIdOf, (at) => (claimedBy.get(at) ?? source) === source && takeable(at));
	const landing = new Map<string, string>();
	const fnPuts: OwnerWrite[] = [];
	for (const { id, function: body } of intent.functions ?? []) {
		if (landing.has(id)) continue;
		const claim = claimFor(id);
		if ("refused" in claim) return claimRefusal(claim);
		landing.set(id, claim.id);
		claimedBy.set(claim.id, id);
		// Held function stays in place.
		if (inPlace.has(id) && functionAt(id)) continue;
		fnPuts.push(putFunction(claim.id, body, functionAt(claim.id)?.revision ?? 0, { revive: true, unfit: true }));
	}
	/** Never bound to a staying function. */
	const repointed = (automation: Automation): Automation | Extract<Claim, { refused: string }> => {
		const pointer = pointerOf(automation);
		if (!pointer) return automation;
		const landed = landing.get(pointer.function);
		const claim = landed === undefined ? claimFor(pointer.function) : { id: landed };
		if ("refused" in claim || claim.id === pointer.function) return "refused" in claim ? claim : automation;
		return AutomationSchema.parse({
			...automation,
			actions: written(automation).map((action) =>
				action === pointer ? { ...pointer, function: claim.id } : action,
			),
		} satisfies AutomationInput);
	};
	const puts: OwnerWrite[] = [];
	for (const [id, automation] of wanted) {
		const current = heldAt(id);
		if ((current && !movesWithHome(current.body)) || functionAt(id))
			return refused(`another record holds the id ${id}`, { code: "invalid", id });
		const body = repointed(automation);
		if ("refused" in body) return claimRefusal(body);
		puts.push(put(id, body, current?.revision ?? 0, true, true));
	}
	// The store caps the final count.
	return { kind: "writes", writes: [...leaving.map(remove), ...fnPuts, ...puts], dropped };
}

export function judgeAutomationWrite(intent: AutomationIntent, view: AutomationJudgeView): AutomationVerdict {
	const heldAt = (id: string) => view.held.find((record) => record.id === id);
	switch (intent.kind) {
		case "owner_put":
		case "save":
			return judgeSave(intent, view);
		case "owner_remove":
			return {
				kind: "writes",
				writes: [{ op: "remove", id: intent.id, base: intent.base }, ...unused(view, intent.id, null)],
				dropped: [],
			};
		case "carry":
			return judgeCarry(intent, view);
		case "sweep": {
			const unusedNow = (id: string) => {
				const users = usersOf(view, id);
				return users !== "unknown" && users.length === 0;
			};
			const writes = view.functions.filter((fn) => intent.ids.includes(fn.id) && unusedNow(fn.id)).map(remove);
			return { kind: "writes", writes, dropped: [] };
		}
		case "adoption": {
			const { wanted, dropped } = fitting(intent.rows, view, true);
			// Rules were stored at the home.
			const puts = [...wanted].flatMap(([id, automation]) => (heldAt(id) ? [] : [put(id, automation, 0, true)]));
			return { kind: "writes", writes: puts, dropped };
		}
		case "conversion": {
			const { prefix, rows } = intent;
			if ([...rows.keys()].some((id) => !id.startsWith(prefix)))
				return refused("not this sensor's alert", { code: "invalid" });
			/** As its sensor's page wrote it. */
			const stored = ({ id, body }: OwnerRecord<Automation>) =>
				id.startsWith(prefix) && body.trigger.kind === "value" && body.trigger.field.startsWith(prefix);
			const stale = view.held.filter((record) => stored(record) && !rows.has(record.id));
			// Replaces only; an owner's edit or delete stands.
			const puts = [...rows].flatMap(([id, body]) => {
				const current = heldAt(id);
				return current && stored(current) ? [put(id, body, current.revision)] : [];
			});
			return { kind: "writes", writes: [...stale.map(remove), ...puts], dropped: [] };
		}
	}
}
