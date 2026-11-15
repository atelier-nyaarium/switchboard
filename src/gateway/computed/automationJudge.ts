// Every automation write, judged once.

import { canonicalJson } from "../../shared/canonical-json.js";
import {
	AUTOMATION_ACTIONS,
	type Automation,
	AutomationSchema,
	type CarriedAutomation,
	canonicalAutomation,
	dangerousActions,
} from "../../shared/schemasAutomation.js";
import type { OwnerRecord, OwnerWrite } from "../ownerRecords.js";

export const AUTOMATION_KIND = "automation";

export const NOT_HOME = "the assistant does not live on this Gateway";

export type AutomationIntent =
	| { kind: "owner_put"; id: string; body: unknown; base: number; confirmed?: boolean }
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
	/** Unread rows included. */
	count: number;
	max: number;
	isHome: boolean;
	/** Why this Gateway cannot run it. */
	issue: (body: Automation) => string | null;
}

export interface DroppedAutomation {
	id: string;
	reason: string;
}

export type AutomationVerdict =
	/** `confirm` names the actions a save must confirm. */
	| { kind: "refused"; reason: string; confirm?: string[] }
	| { kind: "writes"; writes: OwnerWrite[]; dropped: DroppedAutomation[] };

/** Leaves and arrives with the assistant. */
export const movesWithHome = (body: Automation): boolean => body.trigger.kind === "event";

const refused = (reason: string): AutomationVerdict => ({ kind: "refused", reason });

const put = (id: string, body: unknown, base: number, revive = false, unfit = false): OwnerWrite => ({
	op: "put",
	kind: AUTOMATION_KIND,
	id,
	body,
	base,
	...(revive ? { revive } : {}),
	...(unfit ? { unfit } : {}),
});

const remove = ({ id, revision }: OwnerRecord<Automation>): OwnerWrite => ({ op: "remove", id, base: revision });

/** Dangerous actions the held record lacks. */
function unconfirmed(next: Automation, held: Automation | undefined): string[] {
	const known = new Set((held ? dangerousActions(held) : []).map((action) => canonicalJson(action)));
	const asks = dangerousActions(next).filter((action) => !known.has(canonicalJson(action)));
	return [...new Set(asks.map((action) => AUTOMATION_ACTIONS[action.kind].label))];
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
		case "owner_put": {
			const parsed = AutomationSchema.safeParse(intent.body);
			if (parsed.success && movesWithHome(parsed.data) && !view.isHome) return refused(NOT_HOME);
			const confirm =
				parsed.success && !intent.confirmed ? unconfirmed(parsed.data, heldAt(intent.id)?.body) : [];
			if (confirm.length > 0) return { kind: "refused", reason: "confirm what it does without asking", confirm };
			const body = parsed.success ? canonicalAutomation(parsed.data) : intent.body;
			return { kind: "writes", writes: [put(intent.id, body, intent.base)], dropped: [] };
		}
		case "owner_remove":
			return { kind: "writes", writes: [{ op: "remove", id: intent.id, base: intent.base }], dropped: [] };
		case "carry": {
			// Kept and reads invalid, so a move loses nothing.
			const { wanted, dropped } = fitting(intent.rows, view, false);
			const leaving = view.held.filter((record) => movesWithHome(record.body) && !wanted.has(record.id));
			const puts: OwnerWrite[] = [];
			let created = 0;
			for (const [id, automation] of wanted) {
				const current = heldAt(id);
				if (current && !movesWithHome(current.body)) return refused(`another automation holds the id ${id}`);
				if (!current) created += 1;
				puts.push(put(id, automation, current?.revision ?? 0, true, true));
			}
			const staying = view.count - leaving.length;
			const over = staying + created - view.max;
			if (over > 0) {
				return refused(
					`${over} of the carried automations do not fit: this Gateway holds ${staying} of ${view.max}`,
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
			if ([...rows.keys()].some((id) => !id.startsWith(prefix))) return refused("not this sensor's alert");
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
