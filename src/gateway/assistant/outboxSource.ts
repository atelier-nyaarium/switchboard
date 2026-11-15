// The automations' outbox, listed in the assistant's lane.

import { SENSORS_SOURCE_ID } from "../../shared/schemasAssistantActions.js";
import type { AutomationOutbox } from "../computed/automations.js";
import type { ListPage, ListQuery, PollAnswer, Source } from "./source.js";

const FALLBACK_POLL_MS = 10 * 60 * 1000;

export function createOutboxSource(outbox: AutomationOutbox): Source {
	return {
		id: SENSORS_SOURCE_ID,
		label: "Sensors",
		fieldSpecs: [
			{ kind: "text", field: "automation", label: "Automation" },
			{ kind: "text", field: "field", label: "Field" },
			{ kind: "text", field: "value", label: "Value" },
		],
		async poll(cursor): Promise<PollAnswer> {
			const revision = String(outbox.revision());
			if (cursor === revision) return { kind: "unchanged", nextPollMs: FALLBACK_POLL_MS };
			return {
				kind: "events",
				events: outbox.events(),
				cursor: revision,
				capped: false,
				nextPollMs: FALLBACK_POLL_MS,
			};
		},
		async list(query: ListQuery): Promise<ListPage> {
			const since = query.scope === "new" ? (query.since ?? 0) : -1;
			const shown = outbox
				.events()
				.filter((event) => event.at > since)
				.reverse();
			return { events: shown, here: "p0", ...(query.scope === "new" ? { mark: outbox.revision() } : {}) };
		},
	};
}
