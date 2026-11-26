// Every automation write, judged once.

import { eventWords } from "../../shared/automation-fit.js";
import {
	callsOf,
	type FollowedEntry,
	type FunctionOf,
	pointerOf,
	type RunFunction,
	reached,
	reachOf,
	recalled,
	steering,
	visit,
	written,
} from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import {
	AUTOMATION_ACTIONS,
	type Automation,
	type AutomationActionKind,
	type AutomationInput,
	AutomationSchema,
	actionTexts,
	type CarriedAutomation,
	type CarriedFunction,
	canonicalAutomation,
} from "../../shared/schemasAutomation.js";
import { type AutomationSaveRefusal, SAVE_LINE_MAX } from "../../shared/schemasAutomationSave.js";
import { type AutomationFunction, FunctionSchema, unnamed } from "../../shared/schemasFunction.js";
import type { OwnerRecord, OwnerWrite } from "../ownerRecords.js";
import {
	type BodyIssue,
	type CallIssue,
	FUNCTION_PRIVATE,
	isFitIssue,
	isStepIssue,
	lineOf,
	NO_SWITCH,
} from "./automationValidity.js";

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
			/** Functions its calls reach, written with it. */
			called?: readonly { id: string; body: unknown; base: number }[];
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
	/** Unread function rows. */
	unreadFunctions: number;
	isHome: boolean;
	/** Omitted lookup reads storage. */
	assess: (body: Automation, functions?: FunctionOf) => BodyIssue[];
	/** Null without a key. */
	copyIdOf: (automationId: string, from: string) => string | null;
	/** Null without a key. */
	carryIdOf: (from: string) => string | null;
	/** A row this build cannot read holds it. */
	unreadAt: (id: string) => boolean;
	/** A function row this build cannot read. */
	unreadFunctionAt: (id: string) => boolean;
}

export interface DroppedAutomation {
	id: string;
	/** Fixed word; logged. */
	why: "not_event" | BodyIssue["at"];
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

/** The same but for `enabled`. */
const sameBody = (a: Automation, b: Automation): boolean =>
	canonicalJson({ ...a, enabled: true }) === canonicalJson({ ...b, enabled: true });

const onlyEnabledMoved = (next: Automation, held: Automation | undefined): boolean =>
	held !== undefined && sameBody(next, held);

const doneKind = (at: FollowedEntry): string | null =>
	visit(at, {
		action: ({ action }) => action.kind,
		step: { do: ({ step }) => step.action, call: () => null, ...steering(() => null) },
		unfollowedCall: () => null,
	});

/** One key for an action, flat or as a step. */
const dangerKey = (at: FollowedEntry): string | null =>
	visit(at, {
		action: ({ action }) => (stepDanger(action.kind) ? canonicalJson(action) : null),
		step: {
			do: ({ step }) => {
				if (!stepDanger(step.action)) return null;
				const values = Object.entries(step.args).map(([name, arg]) => [
					name,
					arg.kind === "literal" ? arg.value : { expression: arg.text },
				]);
				return canonicalJson({ kind: step.action, ...Object.fromEntries(values) });
			},
			call: () => null,
			...steering(() => null),
		},
		unfollowedCall: () => null,
	});

const stepDanger = (kind: string): boolean =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) && AUTOMATION_ACTIONS[kind as AutomationActionKind].danger;

const labelOf = (kind: string): string =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) ? AUTOMATION_ACTIONS[kind as AutomationActionKind].label : kind;

const CALL_KIND: RunFunction["kind"] = "run_function";

const LABEL_MAX = 80;

const listed = (words: readonly string[]): string =>
	words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/** The event's words a dangerous step would send out. */
const sentWords = (at: FollowedEntry): string[] =>
	visit(at, {
		action: ({ action }) =>
			stepDanger(action.kind)
				? eventWords({ texts: actionTexts(action).map((held) => held.text), expressions: [] })
				: [],
		step: {
			do: ({ step }) => {
				if (!stepDanger(step.action)) return [];
				const args = Object.values(step.args);
				return eventWords({
					texts: args.flatMap((arg) =>
						arg.kind === "literal" && typeof arg.value === "string" ? [arg.value] : [],
					),
					expressions: args.flatMap((arg) => (arg.kind === "expression" ? [arg.text] : [])),
				});
			},
			call: (): string[] => [],
			...steering((): string[] => []),
		},
		unfollowedCall: () => [],
	});

/** What a confirm asks, naming outside words that would leave. */
const askLabel = (at: FollowedEntry): string => {
	const label = labelOf(doneKind(at) ?? CALL_KIND);
	const words = sentWords(at);
	return (words.length === 0 ? label : `${label}, with the event's ${listed(words)}`).slice(0, LABEL_MAX);
};

/** New dangerous actions; for an event user, all new reach. */
function asksOf(next: FollowedEntry[], held: FollowedEntry[] | null, event: boolean, heldWasEvent: boolean): string[] {
	const known = new Set((held ?? []).map(dangerKey).filter((key) => key !== null));
	const danger = next.filter((at) => {
		const key = dangerKey(at);
		return key !== null && !known.has(key);
	});
	// Unfollowed calls prove nothing.
	const prior = (held ?? []).map(doneKind).filter((kind) => kind !== null);
	const toldOnly = !heldWasEvent || prior.every((kind) => kind === "tell_assistant");
	const reach = event && toldOnly ? next.filter((at) => doneKind(at) !== "tell_assistant") : [];
	return [...danger, ...reach].map(askLabel);
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
	/** Pointer's first, then called. */
	const fnWrites = new Map<string, { body: AutomationFunction; base: number; revive?: true }>();
	if (fnWrite) fnWrites.set(fnWrite.id, fnWrite);
	const called = intent.kind === "save" ? (intent.called ?? []) : [];
	for (const each of called) {
		const body = FunctionSchema.safeParse(each.body);
		if (!body.success) {
			const path = body.error.issues[0]?.path.join(".") ?? "";
			return refused("the function is invalid", { code: "invalid", record: "function", id: each.id, path });
		}
		if (each.id === intent.id || heldAt(each.id))
			return refused("an automation holds that id", { code: "invalid", record: "function", id: each.id });
		if (fnWrites.has(each.id))
			return refused("a function is written twice", { code: "invalid", record: "function", id: each.id });
		fnWrites.set(each.id, { body: body.data, base: each.base });
	}
	const pointer = pointerOf(next);
	const toggle = !sent && called.length === 0 && onlyEnabledMoved(next, held?.body);

	const functionNext = (id: string): AutomationFunction | null =>
		fnWrites.get(id)?.body ?? functionAt(id)?.body ?? null;
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
	const enters = reachOf(next, functionNext);
	const stray = [...fnWrites.keys()].find((id) => !enters.has(id));
	if (stray !== undefined)
		return refused("the automation does not run it", { code: "invalid", record: "function", id: stray });
	// Unnamed: one pointer, no caller.
	if (!toggle) {
		const after = [
			...view.functions.filter((record) => !fnWrites.has(record.id)),
			...[...fnWrites].map(([id, each]) => ({ id, body: each.body })),
		];
		const callers = new Set(after.flatMap((each) => callsOf(each.body)));
		const pointers = (id: string) =>
			view.held.filter((record) => record.id !== intent.id && pointerOf(record.body)?.function === id).length +
			(pointer?.function === id ? 1 : 0);
		const written = new Set([...fnWrites.values()].flatMap((each) => callsOf(each.body)));
		const shared = after.find(
			({ id, body }) =>
				unnamed(body) &&
				(fnWrites.has(id) || pointer?.function === id || written.has(id)) &&
				(pointers(id) > 1 || callers.has(id)),
		);
		if (shared) return refused(FUNCTION_PRIVATE, { code: "private", record: "function", id: shared.id });
	}
	// Fresh reach needs sound functions.
	const before = held ? reachOf(held.body, functionHeld) : new Set<string>();
	const fresh = new Set([...enters].filter((id) => !before.has(id) && !fnWrites.has(id)));
	if (!toggle && fresh.size > 0) {
		const unsound = view.assess(next, functionNext).find((issue) => isStepIssue(issue) && fresh.has(issue.via));
		if (unsound && isStepIssue(unsound))
			return refused(lineOf(unsound), { code: "invalid", record: "function", id: unsound.via });
	}

	// Every automation reaching a write.
	const users = [
		{ id: intent.id, body: next, held: held?.body ?? null },
		...view.held
			.filter((record) => {
				if (record.id === intent.id || fnWrites.size === 0) return false;
				const reaches = reachOf(record.body, functionNext);
				return [...fnWrites.keys()].some((id) => reaches.has(id));
			})
			.map((record) => ({ id: record.id, body: record.body, held: record.body })),
	];

	if (!toggle && fnWrites.size > 0) {
		// Its own row may echo unchecked.
		const cut = view.assess(next, functionNext).find((issue) => issue.at === "call");
		if (cut?.at === "call") {
			const code = cut.why === "loop" || cut.why === "private" ? cut.why : "invalid";
			return refused(cut.message, { code, record: "function", id: cut.function });
		}
	}

	if (!toggle) {
		/** A fit issue, or a call another edit cut. */
		const issueUnder = (body: Automation, functions: FunctionOf): CallIssue | { cut: string } | null => {
			const found = view.assess(body, functions).find((issue) => isFitIssue(issue) || issue.at === "call");
			if (!found) return null;
			return isFitIssue(found) ? found.issue : { cut: lineOf(found) };
		};
		/** Held users only fail on new reach. */
		const issueOf = (body: Automation, own: boolean) => {
			const after = issueUnder(body, functionNext);
			if (own || after === null) return after;
			const before = issueUnder(body, functionHeld);
			return before !== null && canonicalJson(before) === canonicalJson(after) ? null : after;
		};
		const own = issueOf(next, true);
		if (own && "kind" in own && own.kind === "switch") {
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

	// Functions land first, so the automation's check sees them.
	const writes: OwnerWrite[] = [...fnWrites].map(([id, each]) =>
		putFunction(id, each.body, each.base, each.revive ? { revive: true } : {}),
	);
	writes.push(put(intent.id, next, intent.base, false, toggle));
	return { kind: "writes", writes: [...writes, ...unused(view, intent.id, next, functionNext)], dropped: [] };
}

/** Pointers and callers; unread means unknown. */
export function usersOf(
	view: Pick<AutomationJudgeView, "held" | "functions" | "unreadAutomations" | "unreadFunctions">,
	id: string,
): readonly string[] | "unknown" {
	if (view.unreadAutomations > 0 || view.unreadFunctions > 0) return "unknown";
	const pointing = view.held.filter((record) => pointerOf(record.body)?.function === id);
	const calling = view.functions.filter((record) => record.id !== id && callsOf(record.body).includes(id));
	return [...pointing, ...calling].map((record) => record.id);
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

/** Its old function, once unrun. */
function unused(
	view: AutomationJudgeView,
	id: string,
	next: Automation | null,
	functionNext: FunctionOf = () => null,
): OwnerWrite[] {
	const held = view.held.find((record) => record.id === id);
	const was = held ? pointerOf(held.body)?.function : undefined;
	if (was === undefined || (next && pointerOf(next)?.function === was)) return [];
	// Its new function may call it.
	if (next && reachOf(next, functionNext).has(was)) return [];
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
		const why = !movesWithHome(automation)
			? "not_event"
			: runnable
				? (view.assess(automation)[0]?.at ?? null)
				: null;
		if (why === null) wanted.set(id, canonicalAutomation(automation));
		else dropped.push({ id, why });
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
	const leaves = (user: string): boolean => {
		const held = heldAt(user);
		return wanted.has(user) || (held !== undefined && movesWithHome(held.body));
	};
	/** Least fixed point; rings excluded. */
	const movingFunctions = new Set<string>();
	const usersBy = new Map(view.functions.map((fn) => [fn.id, usersOf(view, fn.id)]));
	for (let grew = true; grew; ) {
		grew = false;
		for (const [id, users] of usersBy) {
			if (movingFunctions.has(id) || users === "unknown" || users.length === 0) continue;
			if (!users.every((user) => leaves(user) || movingFunctions.has(user))) continue;
			movingFunctions.add(id);
			grew = true;
		}
	}
	const moves = (user: string): boolean => leaves(user) || movingFunctions.has(user);
	const takeable = takeableBy(view, moves);
	/** The function an automation already here holds, which it keeps. */
	const keptBy = (id: string): string | null => {
		const held = heldAt(id);
		const own = held && movesWithHome(held.body) ? pointerOf(held.body)?.function : undefined;
		return own !== undefined && (functionAt(own) !== undefined || view.unreadFunctionAt(own)) ? own : null;
	};
	/** Kept, callees too; nothing lands there. */
	const inPlace = new Set<string>();
	const keep = (id: string): void => {
		if (inPlace.has(id)) return;
		inPlace.add(id);
		const fn = functionAt(id);
		for (const called of fn ? callsOf(fn.body) : []) keep(called);
	};
	for (const id of wanted.keys()) {
		const own = keptBy(id);
		if (own !== null) keep(own);
	}
	/** Nothing is held there. */
	const vacant = (at: string): boolean => !view.unreadAt(at) && !heldAt(at) && !functionAt(at);
	const carried = new Map<string, AutomationFunction>();
	for (const { id, function: body } of intent.functions ?? []) if (!carried.has(id)) carried.set(id, body);
	/** Landing id to its one source. */
	const claimedBy = new Map<string, string>();
	const landing = new Map<string, string>();
	let unclaimed: Extract<Claim, { refused: string }> | null = null;
	/** A carried function: its own id or a derived one. One that did not come: where nothing is held. */
	const land = (source: string): string | null => {
		const landed = landing.get(source);
		if (landed !== undefined) return landed;
		const may = carried.has(source)
			? takeable
			: // Older phone: move back finds it.
				intent.functions === null
				? (at: string) => (at === source ? takeable(at) : vacant(at))
				: vacant;
		// A kept body's dangling call may share its id with a reference, never with a body.
		const reserved = (at: string) => inPlace.has(at) && (carried.has(source) || !vacant(at));
		const claim = claimDerived(
			source,
			view.carryIdOf,
			(at) => !reserved(at) && (claimedBy.get(at) ?? source) === source && may(at),
		);
		if ("refused" in claim) {
			unclaimed ??= claim;
			return null;
		}
		claimedBy.set(claim.id, source);
		landing.set(source, claim.id);
		return claim.id;
	};
	const fnPuts: OwnerWrite[] = [];
	const built = new Set<string>();
	/** Writes a landed function, then what it calls. */
	const build = (source: string): void => {
		const body = carried.get(source);
		const at = landing.get(source);
		if (!body || at === undefined || built.has(source)) return;
		built.add(source);
		const steps = recalled(body, (callee) => land(callee) ?? callee);
		const landed = FunctionSchema.parse({ name: body.name, params: body.params, steps });
		fnPuts.push(putFunction(at, landed, functionAt(at)?.revision ?? 0, { revive: true, unfit: true }));
		for (const callee of callsOf(body)) build(callee);
	};
	const puts: OwnerWrite[] = [];
	for (const [id, automation] of wanted) {
		const current = heldAt(id);
		if ((current && !movesWithHome(current.body)) || functionAt(id))
			return refused(`another record holds the id ${id}`, { code: "invalid", id });
		const pointer = pointerOf(automation);
		const kept = keptBy(id);
		const at = pointer ? (kept ?? land(pointer.function)) : null;
		if (pointer && kept === null) build(pointer.function);
		const body =
			pointer && at !== null && at !== pointer.function
				? AutomationSchema.parse({
						...automation,
						actions: written(automation).map((action) =>
							action === pointer ? { ...pointer, function: at } : action,
						),
					} satisfies AutomationInput)
				: automation;
		puts.push(put(id, body, current?.revision ?? 0, true, true));
	}
	if (unclaimed) return claimRefusal(unclaimed);
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
			// An unread row may reach anything.
			if (view.unreadAutomations > 0 || view.unreadFunctions > 0)
				return { kind: "writes", writes: [], dropped: [] };
			const functionHeld = (id: string) => view.functions.find((record) => record.id === id)?.body ?? null;
			const run = new Set(view.held.flatMap((record) => [...reachOf(record.body, functionHeld)]));
			const writes = view.functions.filter((fn) => intent.ids.includes(fn.id) && !run.has(fn.id)).map(remove);
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
