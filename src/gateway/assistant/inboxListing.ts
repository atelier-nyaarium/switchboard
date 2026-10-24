// The assistant's live inbox: one signed page at a time, and the mark a `new` read moves.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import type { InboxItem, InboxList, InboxScope } from "../../shared/schemasAssistantInbox.js";
import { type AssistantWatcherRules, decideEvent } from "../../shared/schemasAssistantRules.js";
import { ASSISTANT_WAITS } from "./waits.js";
import type { ListPage, ListQuery, Watcher } from "./watcher.js";
import type { WatcherStateStore } from "./watcherState.js";

/** Past it, the rest of a page is cut. */
const MAX_LIST_BYTES = 64_000;

export interface InboxListingDeps {
	watchers: readonly Watcher[];
	state: Pick<WatcherStateStore, "get" | "put">;
	rulesFor: (watcherId: string) => AssistantWatcherRules;
	ambient: Pick<Ambient, "randomBytes">;
	/** One page read in the watcher's lane; the query is built there, so it reads the lane's mark. */
	livePage: <T>(
		watcherId: string,
		query: () => ListQuery,
		deadlineMs: number,
		settle: (page: ListPage) => T,
	) => Promise<T>;
}

export interface InboxListing {
	list(scope: InboxScope, page?: string): Promise<InboxList[]>;
}

/** A watcher's own page token, and how many of its items were shown. */
interface PageAt {
	watcherId: string;
	inner?: string;
	skip: number;
}

const PageBodySchema = z.tuple([z.string(), z.string().nullable(), z.number().int().nonnegative()]);

export function createInboxListing(deps: InboxListingDeps): InboxListing {
	const { state } = deps;
	/** Signed, so the agent can neither forge nor edit one. */
	const pageKey = deps.ambient.randomBytes(32);
	const signed = (body: string) => createHmac("sha256", pageKey).update(body).digest("base64url");
	const wrapPage = (at: PageAt) => {
		const body = JSON.stringify([at.watcherId, at.inner ?? null, at.skip]);
		return Buffer.from(JSON.stringify([body, signed(body)])).toString("base64url");
	};
	const unwrapPage = (page: string): PageAt | null => {
		try {
			const [body, signature] = z
				.tuple([z.string(), z.string()])
				.parse(JSON.parse(Buffer.from(page, "base64url").toString("utf8")));
			const expected = Buffer.from(signed(body));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			const [watcherId, inner, skip] = PageBodySchema.parse(JSON.parse(body));
			return { watcherId, ...(inner === null ? {} : { inner }), skip };
		} catch {
			return null;
		}
	};

	/**
	 * A cut page continues from its first unshown item. A `new` read's last page moves the mark only
	 * once it is shown whole.
	 */
	const listOne = (watcher: Watcher, scope: InboxScope, at: Omit<PageAt, "watcherId">): Promise<InboxList> => {
		const { label } = watcher;
		const query = (): ListQuery => {
			const since = scope === "new" ? state.get(watcher.id).mark : undefined;
			return { scope, ...(since === undefined ? {} : { since }), ...(at.inner ? { page: at.inner } : {}) };
		};
		return deps
			.livePage(watcher.id, query, ASSISTANT_WAITS.list, (read) => {
				const decided = deps.rulesFor(watcher.id);
				const shown: InboxItem[] = read.events.slice(at.skip).map((event) => {
					const { title: _title, ...fields } = event.fields;
					return {
						id: event.id,
						title: event.title,
						...(event.url === undefined ? {} : { url: event.url }),
						fields,
						at: event.at,
						decision: decideEvent(decided, watcher.fieldSpecs, event.fields),
					};
				});
				const items = withinBytes(shown, MAX_LIST_BYTES);
				const whole = items.length === shown.length;
				const held = state.get(watcher.id);
				const moves = read.mark !== undefined && whole && read.mark > (held.mark ?? -1);
				const unsaved = moves && !state.put(watcher.id, { ...held, mark: read.mark });
				const next = whole
					? read.next === undefined
						? undefined
						: wrapPage({ watcherId: watcher.id, inner: read.next, skip: 0 })
					: wrapPage({ watcherId: watcher.id, inner: read.here, skip: at.skip + items.length });
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
			const listed = deps.watchers.filter(
				(watcher) => watcher.list && (!asked || asked.watcherId === watcher.id),
			);
			return Promise.all(listed.map((watcher) => listOne(watcher, scope, asked ?? { skip: 0 })));
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
