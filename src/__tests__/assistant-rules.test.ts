import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRulesStore } from "../gateway/assistant/rulesStore.js";
import type { PollAnswer, Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { type AssistantVault, composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { DurableStore } from "../shared/durable-store.js";
import {
	type AssistantRule,
	type AssistantWatcherRules,
	decideEvent,
	rulesRefusal,
} from "../shared/schemasAssistantRules.js";
import { SessionStore } from "../shared/session-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const FIELDS = ["reason", "repository"];

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const rule = (field: string, value: string, action: AssistantRule["action"], ping?: boolean): AssistantRule => ({
	conditions: [{ field, test: "is", value }],
	action,
	...(ping === undefined ? {} : { ping }),
});

const event = (sourceId: string, reason: string): WatcherEvent => ({
	sourceId,
	at: 1,
	title: `${reason} ${sourceId}`,
	fields: { reason, repository: "atelier/app" },
});

/** Next batch per poll. */
function feed(batches: WatcherEvent[][]): Watcher {
	return {
		id: "github",
		fields: FIELDS,
		pingDefault: false,
		poll: async (): Promise<PollAnswer> => ({
			kind: "events",
			events: batches.shift() ?? [],
			cursor: "c",
			nextPollMs: 60_000,
		}),
	};
}

function stage(dataDir: string, watcher: Watcher, ambient: FakeAmbient) {
	const store = new SessionStore({ ambient: processAmbient() });
	const grants = new Map<string, string[]>();
	const vault: AssistantVault = {
		watcherGrants: (id) => grants.get(id) ?? [],
		setWatcherGrants: (id, entryIds) => void grants.set(id, entryIds),
		readForWatcher: async () => ({ kind: "released", value: "token" }),
	};
	return composeAssistant({
		dataDir,
		ambient,
		sessions: { sessionStore: store, presence: store } as never,
		saveSessions: () => {},
		vault,
		fetch: async () => new Response(null, { status: 304 }),
		watchers: [watcher],
	});
}

const freshDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-rules-"));
	dirs.push(dir);
	return dir;
};

describe("a watcher's rules", () => {
	it("decide by the first rule that matches, case aside, and anything else takes the fallback", () => {
		const rules: AssistantWatcherRules = {
			rules: [
				rule("reason", "Review_Requested", "wake", true),
				{ conditions: [{ field: "repository", test: "contains", value: "atelier" }], action: "inbox" },
				rule("reason", "subscribed", "drop"),
			],
			otherwise: { action: "drop" },
			revision: 4,
		};

		expect(decideEvent(rules, { reason: "review_requested", repository: "x/y" }, false)).toEqual({
			action: "wake",
			ping: true,
			rulesRevision: 4,
		});
		expect(decideEvent(rules, { reason: "subscribed", repository: "atelier/app" }, false).action).toBe("inbox");
		// A drop never pings, whatever the default.
		expect(decideEvent(rules, { reason: "mention", repository: "x/y" }, true)).toMatchObject({
			action: "drop",
			ping: false,
		});
		expect(rulesRefusal([rule("label", "x", "drop")], FIELDS)).not.toBeNull();
		expect(rulesRefusal([rule("reason", "x", "drop")], FIELDS)).toBeNull();
	});

	it("match a rule only when every condition holds", () => {
		const rules: AssistantWatcherRules = {
			rules: [
				{
					conditions: [
						{ field: "reason", test: "is_not", value: "subscribed" },
						{ field: "repository", test: "is", value: "atelier/app" },
					],
					action: "wake",
				},
			],
			otherwise: { action: "inbox" },
			revision: 1,
		};

		expect(decideEvent(rules, { reason: "mention", repository: "atelier/app" }, false).action).toBe("wake");
		expect(decideEvent(rules, { reason: "subscribed", repository: "atelier/app" }, false).action).toBe("inbox");
		expect(decideEvent(rules, { reason: "mention", repository: "x/y" }, false).action).toBe("inbox");
	});

	it("refuse a put whose write fails, keeping the held revision and sorting nothing", () => {
		let changed = 0;
		const failing = {
			load: () => null,
			saveChecked: () => {
				throw new Error("disk full");
			},
		} as unknown as DurableStore;
		const store = createRulesStore({ store: failing, onChanged: () => void changed++ });

		const put = store.put("github", [rule("reason", "x", "drop")], { action: "inbox" }, 0);

		expect(put.stored).toBe(false);
		expect(store.get("github").revision).toBe(0);
		expect(changed).toBe(0);
	});

	it("store a drop without its ping, and answer a retried save whose first answer was lost as stored, once", () => {
		let changed = 0;
		const store = createRulesStore({
			store: new DurableStore(freshDir(), "assistant-rules"),
			onChanged: () => void changed++,
		});
		const list = [rule("reason", " subscribed ", "drop", true)];
		const otherwise = { action: "drop", ping: true } as const;

		store.put("github", list, otherwise, 0);
		const retried = store.put("github", list, otherwise, 0);
		const other = store.put("github", [], otherwise, 0);

		expect(retried).toMatchObject({ stored: true, rules: { revision: 1 } });
		expect(other.stored).toBe(false);
		expect(changed).toBe(1);
		expect(store.get("github")).toEqual({
			rules: [{ conditions: [{ field: "reason", test: "is", value: "subscribed" }], action: "drop" }],
			otherwise: { action: "drop" },
			revision: 1,
		});
	});

	it("sort each event as it lands, and an edit replays the kept drops it now catches", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const assistant = stage(freshDir(), feed([[event("1", "subscribed"), event("2", "mention")]]), ambient);
		await assistant.console.place("~/notes");
		await assistant.console.putRules("github", [rule("reason", "subscribed", "drop")], { action: "inbox" }, 0);
		assistant.start();
		await ambient.advance(0);
		const sorted = assistant.console.state().watchers[0];
		const atelier: AssistantRule = {
			conditions: [{ field: "repository", test: "contains", value: "ATELIER" }],
			action: "wake",
		};
		const appended = assistant.console.previewRule("github", atelier);
		const first = assistant.console.previewRule("github", atelier, 0);

		const stale = assistant.console.putRules("github", [], { action: "inbox" }, 0);
		const edited = await assistant.console.putRules("github", [], { action: "inbox" }, 1);
		const done = assistant.stop();
		await ambient.advance(5_000);
		await done;

		expect(sorted).toMatchObject({ unread: 1, dropped: 1 });
		// After the drop rule, it decides only what that rule leaves.
		expect(appended).toMatchObject({ matched: 1, earlier: 1, of: 2, titles: ["mention 2"] });
		expect(first).toMatchObject({ matched: 2, earlier: 0 });
		await expect(stale).rejects.toThrow();
		expect(edited.watchers[0]).toMatchObject({ unread: 2, dropped: 0, rules: { revision: 2 } });
		expect(() => assistant.console.previewRule("github", rule("label", "x", "wake"))).toThrow();
	});

	it("catch up at start when a crash left the inbox behind the rules", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		const first = stage(dir, feed([[event("1", "subscribed")]]), ambient);
		await first.console.place("~/notes");
		await first.console.putRules("github", [rule("reason", "subscribed", "drop")], { action: "inbox" }, 0);
		first.start();
		await ambient.advance(0);
		const done = first.stop();
		await ambient.advance(5_000);
		await done;
		// Dies before the inbox resorts.
		createRulesStore({ store: new DurableStore(dir, "assistant-rules"), onChanged: () => {} }).put(
			"github",
			[],
			{ action: "inbox" },
			1,
		);

		const second = stage(dir, feed([]), ambient);

		expect(second.console.state().watchers[0]).toMatchObject({ unread: 1, dropped: 0 });
	});

	it("sort again under the defaults when the rules file starts fresh", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		const first = stage(dir, feed([[event("1", "subscribed")]]), ambient);
		await first.console.place("~/notes");
		await first.console.putRules("github", [rule("reason", "subscribed", "drop")], { action: "inbox" }, 0);
		first.start();
		await ambient.advance(0);
		const done = first.stop();
		await ambient.advance(5_000);
		await done;
		fs.rmSync(path.join(dir, "assistant-rules.json"));

		const second = stage(dir, feed([]), ambient);

		expect(second.console.state().watchers[0]).toMatchObject({ unread: 1, dropped: 0, rules: { revision: 0 } });
	});
});
