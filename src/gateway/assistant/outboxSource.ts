// The automations' outbox, listed in the assistant's lane.

import { SENSORS_SOURCE_ID } from "../../shared/schemasAssistantActions.js";
import type { AutomationOutbox, OutboxEvent } from "../computed/automationOutbox.js";
import type { ListPage, ListQuery, PollAnswer, Source, SourceEvent } from "./source.js";

const FALLBACK_POLL_MS = 10 * 60 * 1000;

const eventOf = ({ when, ...event }: OutboxEvent): SourceEvent => ({ ...event, tell: when });

export function createOutboxSource(outbox: AutomationOutbox): Source {
	return {
		id: SENSORS_SOURCE_ID,
		label: "Automations",
		selfTold: true,
		fieldSpecs: [
			{ kind: "text", field: "automation", label: "Automation" },
			{ kind: "text", field: "field", label: "Field" },
			{ kind: "text", field: "value", label: "Value" },
			{ kind: "text", field: "message", label: "Message" },
			{ kind: "text", field: "note", label: "Note" },
		],
		async poll(cursor): Promise<PollAnswer> {
			const revision = String(outbox.revision());
			if (cursor === revision) return { kind: "unchanged", nextPollMs: FALLBACK_POLL_MS };
			return {
				kind: "events",
				events: outbox.events().map(eventOf),
				cursor: revision,
				capped: false,
				nextPollMs: FALLBACK_POLL_MS,
			};
		},
		/** Holds the first read's revision, so later pages cover the same span. */
		async list(query: ListQuery): Promise<ListPage> {
			const since = query.scope === "new" ? (query.since ?? 0) : -1;
			const upTo = query.page === undefined ? outbox.revision() : Number(query.page);
			if (!Number.isSafeInteger(upTo)) throw new Error("stale page; list again");
			const shown = outbox
				.events()
				.filter((event) => event.at > since && event.at <= upTo)
				.map(eventOf)
				.reverse();
			return { events: shown, here: String(upTo), ...(query.scope === "new" ? { mark: upTo } : {}) };
		},
	};
}
