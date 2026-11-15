// The assistant's live inbox.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import type { InboxItem, InboxList, InboxScope } from "../../shared/schemasAssistantInbox.js";
import type { RuleAction } from "../../shared/schemasAssistantRules.js";
import type { ListPage, ListQuery, Source, SourceEvent } from "./source.js";
import { isGone, type SourceStateStore } from "./sourceState.js";
import { ASSISTANT_WAITS } from "./waits.js";

/** Past it, the rest of a page is cut. */
const MAX_LIST_BYTES = 64_000;

export interface InboxListingDeps {
	sources: readonly Source[];
	/** Disabled lists nothing. */
	enabled: (sourceId: string) => boolean;
	state: Pick<SourceStateStore, "get" | "put">;
	decide: (sourceId: string, event: SourceEvent) => RuleAction;
	ambient: Pick<Ambient, "randomBytes">;
	/** One page, read in the source's lane. */
	livePage: <T>(
		sourceId: string,
		query: () => ListQuery,
		deadlineMs: number,
		settle: (page: ListPage) => T,
	) => Promise<T>;
}

export interface InboxListing {
	list(scope: InboxScope, page?: string): Promise<InboxList[]>;
	acted(sourceId: string): void;
}

/** The last item a cut page showed. */
interface Anchor {
	at: number;
	id: string;
}

/** A source's own page token, and where its items were cut. */
interface PageAt {
	sourceId: string;
	inner?: string;
	after?: Anchor;
	acted?: number;
}

const PageBodySchema = z.tuple([
	z.string(),
	z.string().nullable(),
	z.tuple([z.number(), z.string()]).nullable(),
	z.number().int().nonnegative(),
]);

/** After the anchor, else after every item newer than it; newest first. */
const startOf = (listed: readonly SourceEvent[], after: Anchor | undefined): number => {
	if (!after) return 0;
	const held = listed.findIndex((event) => event.id === after.id);
	if (held !== -1) return held + 1;
	const older = listed.findIndex((event) => event.at <= after.at);
	return older === -1 ? listed.length : older;
};

export function createInboxListing(deps: InboxListingDeps): InboxListing {
	const { state } = deps;
	/** Signed, so the agent can neither forge nor edit one. */
	const pageKey = deps.ambient.randomBytes(32);
	const signed = (body: string) => createHmac("sha256", pageKey).update(body).digest("base64url");
	const wrapPage = (at: PageAt & { acted: number }) => {
		const after = at.after ? [at.after.at, at.after.id] : null;
		const body = JSON.stringify([at.sourceId, at.inner ?? null, after, at.acted]);
		return Buffer.from(JSON.stringify([body, signed(body)])).toString("base64url");
	};
	const actions = new Map<string, number>();
	const actedOn = (sourceId: string) => actions.get(sourceId) ?? 0;
	const unwrapPage = (page: string): PageAt | null => {
		try {
			const [body, signature] = z
				.tuple([z.string(), z.string()])
				.parse(JSON.parse(Buffer.from(page, "base64url").toString("utf8")));
			const expected = Buffer.from(signed(body));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			const [sourceId, inner, after, acted] = PageBodySchema.parse(JSON.parse(body));
			return {
				sourceId,
				acted,
				...(inner === null ? {} : { inner }),
				...(after === null ? {} : { after: { at: after[0], id: after[1] } }),
			};
		} catch {
			return null;
		}
	};

	/**
	 * A cut page continues after the last item it showed, whatever left meanwhile. A `new` read's
	 * last page moves the mark only when shown whole and no action ran since its first page.
	 */
	const listOne = (source: Source, scope: InboxScope, at: Omit<PageAt, "sourceId">): Promise<InboxList> => {
		const { label } = source;
		const query = (): ListQuery => {
			const since = scope === "new" ? state.get(source.id).mark : undefined;
			return { scope, ...(since === undefined ? {} : { since }), ...(at.inner ? { page: at.inner } : {}) };
		};
		return deps
			.livePage(source.id, query, ASSISTANT_WAITS.list, (read) => {
				const listed = read.events.filter((event) => !isGone(state.get(source.id), event));
				const unshown = listed.slice(startOf(listed, at.after));
				const shown: InboxItem[] = unshown.map((event) => {
					const { title: _title, ...fields } = event.fields;
					return {
						id: event.id,
						title: event.title,
						...(event.url === undefined ? {} : { url: event.url }),
						fields,
						at: event.at,
						...(deps.decide(source.id, event) === "wake" ? { decision: "now" } : {}),
					};
				});
				const items = withinBytes(shown, MAX_LIST_BYTES);
				const whole = items.length === shown.length;
				const last = items.at(-1);
				const after = last ? { at: last.at, id: last.id } : at.after;
				const held = state.get(source.id);
				const acted = at.acted ?? actedOn(source.id);
				const moves =
					read.mark !== undefined && whole && read.mark > (held.mark ?? -1) && acted === actedOn(source.id);
				const unsaved = moves && !state.put(source.id, { ...held, mark: read.mark });
				const next = whole
					? read.next === undefined
						? undefined
						: wrapPage({ sourceId: source.id, inner: read.next, acted })
					: wrapPage({ sourceId: source.id, inner: read.here, acted, ...(after ? { after } : {}) });
				return {
					label,
					items,
					...(next === undefined ? {} : { next }),
					...(whole ? {} : { cut: shown.length - items.length }),
					...(unsaved ? { error: "listed, but the mark was not saved; the next new read repeats it" } : {}),
				};
			})
			.catch((error: Error) => ({ label, items: [], error: error.message.slice(0, 400) }));
	};

	return {
		async list(scope, page) {
			const asked = page === undefined ? null : unwrapPage(page);
			if (page !== undefined && !asked) {
				return [{ label: "Inbox", items: [], error: "stale page; list again" }];
			}
			const listed = deps.sources.filter(
				(source) => source.list && deps.enabled(source.id) && (!asked || asked.sourceId === source.id),
			);
			return Promise.all(listed.map((source) => listOne(source, scope, asked ?? {})));
		},
		acted(sourceId) {
			actions.set(sourceId, actedOn(sourceId) + 1);
		},
	};
}

/** Leading items that fit, and never none, so a cut page always moves on. */
function withinBytes(items: readonly InboxItem[], max: number): InboxItem[] {
	let used = 0;
	const kept: InboxItem[] = [];
	for (const item of items) {
		used += Buffer.byteLength(JSON.stringify(item));
		if (used > max && kept.length > 0) break;
		kept.push(item);
	}
	return kept;
}
