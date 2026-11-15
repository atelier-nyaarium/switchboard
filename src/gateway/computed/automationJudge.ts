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
import { ALERT_ID_PREFIX, thresholdIds } from "./thresholds.js";

export const AUTOMATION_KIND = "automation";

export const NOT_HOME = "the assistant does not live on this Gateway";

export type AutomationIntent =
	| { kind: "owner_put"; id: string; body: unknown; base: number; confirmed?: boolean }
	| { kind: "owner_remove"; id: string; base: number }
	/** The home's whole moving set. */
	| { kind: "carry"; rows: readonly CarriedAutomation[] }
	// Remove 2026-11-28 with the stored rules.
	| { kind: "adoption"; rows: readonly CarriedAutomation[] }
	/** One sensor's whole alert set. */
	| { kind: "projection"; device: string; rows: ReadonlyMap<string, Automation> };

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

/** Alert ids are their sensor's. */
const ownerRefusal = (id: string, held: OwnerRecord<Automation> | undefined): string | null => {
	if (!id.startsWith(ALERT_ID_PREFIX)) return null;
	return held ? "its sensor page sets this alert" : "not an id an owner names";
};

/** Dangerous actions the held record lacks. */
function unconfirmed(next: Automation, held: Automation | undefined): string[] {
	const known = new Set((held ? dangerousActions(held) : []).map((action) => canonicalJson(action)));
	const asks = dangerousActions(next).filter((action) => !known.has(canonicalJson(action)));
	return [...new Set(asks.map((action) => AUTOMATION_ACTIONS[action.kind].label))];
}

/** The rows that may arrive, last of an id winning; `runnable` drops what this Gateway cannot run. */
function fitting(rows: readonly CarriedAutomation[], view: AutomationJudgeView, runnable: boolean) {
	const wanted = new Map<string, Automation>();
	const dropped: DroppedAutomation[] = [];
	for (const { id, automation } of rows) {
		const reason = id.startsWith(ALERT_ID_PREFIX)
			? "an alert's id is its sensor's"
			: !movesWithHome(automation)
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
			const named = ownerRefusal(intent.id, heldAt(intent.id));
			if (named) return refused(named);
			const parsed = AutomationSchema.safeParse(intent.body);
			if (parsed.success && movesWithHome(parsed.data) && !view.isHome) return refused(NOT_HOME);
			const confirm =
				parsed.success && !intent.confirmed ? unconfirmed(parsed.data, heldAt(intent.id)?.body) : [];
			if (confirm.length > 0) return { kind: "refused", reason: "confirm what it does without asking", confirm };
			const body = parsed.success ? canonicalAutomation(parsed.data) : intent.body;
			return { kind: "writes", writes: [put(intent.id, body, intent.base)], dropped: [] };
		}
		case "owner_remove": {
			const named = ownerRefusal(intent.id, heldAt(intent.id));
			if (named) return refused(named);
			return { kind: "writes", writes: [{ op: "remove", id: intent.id, base: intent.base }], dropped: [] };
		}
		case "carry": {
			// One it cannot run is kept and reads invalid, so a move loses nothing the owner wrote.
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
		case "projection": {
			const prefix = thresholdIds(intent.device, "").field;
			if ([...intent.rows.keys()].some((id) => !id.startsWith(prefix))) return refused("not this sensor's alert");
			const stale = view.held.filter((record) => record.id.startsWith(prefix) && !intent.rows.has(record.id));
			const puts = [...intent.rows].map(([id, body]) => put(id, body, heldAt(id)?.revision ?? 0, true));
			return { kind: "writes", writes: [...stale.map(remove), ...puts], dropped: [] };
		}
	}
}
