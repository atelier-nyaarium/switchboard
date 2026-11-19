// Every automation write, judged once.

import { fitOf, functionReads, type TriggerGiven } from "../../shared/automation-fit.js";
import { type Reached, reached, written } from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import {
	AUTOMATION_ACTIONS,
	type Automation,
	type AutomationAction,
	type AutomationActionKind,
	type AutomationInput,
	AutomationSchema,
	type AutomationTrigger,
	type CarriedAutomation,
	canonicalAutomation,
} from "../../shared/schemasAutomation.js";
import type { AutomationSaveRefusal } from "../../shared/schemasAutomationSave.js";
import { type AutomationFunction, FunctionSchema } from "../../shared/schemasFunction.js";
import type { OwnerRecord, OwnerWrite } from "../ownerRecords.js";

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
			confirmed?: boolean;
	  }
	| { kind: "owner_remove"; id: string; base: number }
	/** The home's whole moving set. */
	| { kind: "carry"; rows: readonly CarriedAutomation[] }
	// Remove 2026-11-28 with the stored rules.
	| { kind: "adoption"; rows: readonly CarriedAutomation[] }
	// Remove 2027-01-15 with the stored thresholds.
	/** One sensor's stored alerts, as plain automations. */
	| { kind: "conversion"; prefix: string; rows: ReadonlyMap<string, Automation> };

export interface AutomationJudgeView {
	/** Readable rows. */
	held: readonly OwnerRecord<Automation>[];
	functions: readonly OwnerRecord<AutomationFunction>[];
	/** Unread rows included. */
	count: number;
	max: number;
	isHome: boolean;
	/** Why this Gateway cannot run it. */
	issue: (body: Automation) => string | null;
	givenOf: (trigger: AutomationTrigger) => TriggerGiven;
	copyIdOf: (automationId: string, from: string) => string;
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
	refusal,
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

const putFunction = (id: string, body: AutomationFunction, base: number): OwnerWrite => ({
	op: "put",
	kind: FUNCTION_KIND,
	id,
	body,
	base,
});

const remove = ({ id, revision }: { id: string; revision: number }): OwnerWrite => ({
	op: "remove",
	id,
	base: revision,
});

export const pointerOf = (body: Automation): RunFunction | null =>
	written(body).find((action): action is RunFunction => action.kind === "run_function") ?? null;

const onlyEnabledMoved = (next: Automation, held: Automation | undefined): boolean =>
	held !== undefined && canonicalJson({ ...next, enabled: true }) === canonicalJson({ ...held, enabled: true });

const dangerKey = (at: Reached): string | null =>
	stepDanger(at.kind) ? canonicalJson("action" in at ? at.action : { kind: at.kind, args: at.step.args }) : null;

const stepDanger = (kind: string): boolean =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) && AUTOMATION_ACTIONS[kind as AutomationActionKind].danger;

const labelOf = (kind: string): string =>
	Object.hasOwn(AUTOMATION_ACTIONS, kind) ? AUTOMATION_ACTIONS[kind as AutomationActionKind].label : kind;

/** New dangerous actions; for an event user, all new reach. */
function asksOf(next: Reached[], held: Reached[] | null, event: boolean): string[] {
	const known = new Set((held ?? []).map(dangerKey).filter((key) => key !== null));
	const danger = next.filter((at) => {
		const key = dangerKey(at);
		return key !== null && !known.has(key);
	});
	const toldOnly = (held ?? []).every((at) => at.kind === "tell_assistant");
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

	let fnWrite: { id: string; body: AutomationFunction; base: number } | null = null;
	const sent = intent.kind === "save" ? intent.function : undefined;
	if (sent) {
		const body = FunctionSchema.safeParse(sent.body);
		if (!body.success) {
			const path = body.error.issues[0]?.path.join(".") ?? "";
			return refused(body.error.issues[0]?.message ?? "not valid", { code: "invalid", record: "function", path });
		}
		if (sent.as === "copy") {
			const from = functionAt(sent.from);
			if (!from) return refused("the function is gone", { code: "gone", record: "function" });
			if (from.revision !== sent.fromBase) {
				return refused(`revision ${from.revision} is stored`, {
					code: "moved",
					record: "function",
					revision: from.revision,
				});
			}
			const id = view.copyIdOf(intent.id, sent.from);
			const pointer = pointerOf(next);
			if (!pointer) return refused("a copy needs a pointer", { code: "invalid", record: "automation" });
			next = AutomationSchema.parse({
				...next,
				actions: actions.map((action) => (action === pointer ? { ...pointer, function: id } : action)),
			} satisfies AutomationInput);
			fnWrite = { id, body: body.data, base: functionAt(id)?.revision ?? 0 };
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

	const functionNext = (id: string): AutomationFunction | null =>
		fnWrite?.id === id ? fnWrite.body : (functionAt(id)?.body ?? null);
	const functionHeld = (id: string): AutomationFunction | null => functionAt(id)?.body ?? null;
	if (pointer && !functionNext(pointer.function))
		return refused("the function it runs is gone", { code: "unknown_function", id: pointer.function });

	const toggle = !sent && onlyEnabledMoved(next, held?.body);
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
		const unfit = users.filter(({ body }) => {
			const at = pointerOf(body);
			const fn = at ? functionNext(at.function) : null;
			if (!at || !fn) return false;
			const reads = functionReads(fn);
			return !fitOf(view.givenOf(body.trigger), { params: fn.params, reads }, at.values ?? {}).fits;
		});
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
			asksOf(reached(body, functionNext), before ? reached(before, functionHeld) : null, movesWithHome(body)),
		);
		if (labels.length > 0) {
			const confirm = [...new Set(labels)];
			return {
				kind: "refused",
				reason: "confirm what it does",
				refusal: { code: "confirm", labels: confirm },
				confirm,
			};
		}
	}

	// The function lands first, so the automation's check sees it.
	const writes: OwnerWrite[] = fnWrite ? [putFunction(fnWrite.id, fnWrite.body, fnWrite.base)] : [];
	writes.push(put(intent.id, next, intent.base));
	return { kind: "writes", writes: [...writes, ...unused(view, intent.id, next)], dropped: [] };
}

function unused(view: AutomationJudgeView, id: string, next: Automation | null): OwnerWrite[] {
	const held = view.held.find((record) => record.id === id);
	const was = held ? pointerOf(held.body)?.function : undefined;
	if (was === undefined || (next && pointerOf(next)?.function === was)) return [];
	const others = view.held.some((record) => record.id !== id && pointerOf(record.body)?.function === was);
	const fn = view.functions.find((record) => record.id === was);
	return others || !fn ? [] : [remove(fn)];
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
		case "carry": {
			// Kept and reads invalid, so a move loses nothing.
			const { wanted, dropped } = fitting(intent.rows, view, false);
			const leaving = view.held.filter((record) => movesWithHome(record.body) && !wanted.has(record.id));
			const puts: OwnerWrite[] = [];
			let created = 0;
			for (const [id, automation] of wanted) {
				const current = heldAt(id);
				if (current && !movesWithHome(current.body))
					return refused(`another automation holds the id ${id}`, { code: "invalid", id });
				if (!current) created += 1;
				puts.push(put(id, automation, current?.revision ?? 0, true, true));
			}
			const staying = view.count - leaving.length;
			const over = staying + created - view.max;
			if (over > 0) {
				return refused(
					`${over} of the carried automations do not fit: this Gateway holds ${staying} of ${view.max}`,
					{ code: "full", kind: "automation", max: view.max },
				);
			}
			return { kind: "writes", writes: [...leaving.map(remove), ...puts], dropped };
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
