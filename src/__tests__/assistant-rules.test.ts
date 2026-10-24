import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRulesStore } from "../gateway/assistant/rulesStore.js";
import type { Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { type AssistantVault, composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { DurableStore } from "../shared/durable-store.js";
import { AssistantWatcherSchema } from "../shared/schemasAssistant.js";
import {
	type AssistantFieldSpec,
	AssistantFieldSpecSchema,
	type AssistantRule,
	type AssistantWatcherRules,
	decideEvent,
} from "../shared/schemasAssistantRules.js";
import { ConsoleOpSchema } from "../shared/schemasConsoleOp.js";
import { SessionStore } from "../shared/session-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const SPECS: AssistantFieldSpec[] = [
	{ kind: "text", field: "reason", label: "Reason" },
	{ kind: "text", field: "repository", label: "Repository" },
];
const CHOICES: AssistantFieldSpec[] = [
	{
		kind: "enumeration",
		field: "reason",
		label: "Reason",
		options: [
			{ value: "review_requested", label: "Review requested" },
			{ value: "mention", label: "Mention" },
		],
	},
	{ kind: "text", field: "repository", label: "Repository" },
];

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const freshDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-rules-"));
	dirs.push(dir);
	return dir;
};

const rule = (
	id: string,
	value: string,
	action: AssistantRule["action"],
	extra: Partial<AssistantRule> = {},
): AssistantRule => ({ id, conditions: [{ field: "reason", test: "is", value }], action, revision: 0, ...extra });

const event = (id: string, reason: string, at = 1): WatcherEvent => ({
	id,
	at,
	title: `${reason} ${id}`,
	fields: { reason, repository: "atelier/app" },
});

/** Lists `held`; polls nothing new. */
function listing(held: WatcherEvent[], fieldSpecs = SPECS): Watcher {
	return {
		id: "github",
		label: "GitHub",
		fieldSpecs,
		poll: async () => ({ kind: "unchanged", nextPollMs: 60_000 }),
		list: async () => ({ events: held, here: "0" }),
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
		routes: () => {
			throw new Error("no Domain");
		},
		fetch: async () => new Response(null, { status: 304 }),
		watchers: [watcher],
	});
}

function rulesStore(dir = freshDir(), store?: DurableStore, specs = SPECS) {
	return createRulesStore({
		store: store ?? new DurableStore(dir, "assistant-rules"),
		specsOf: (watcherId) => (watcherId === "github" ? specs : undefined),
	});
}

const choiceStore = (dir = freshDir()) => rulesStore(dir, undefined, CHOICES);

/** Invalid rule precedes valid rule. */
function seedStale(dir: string, stale: AssistantRule) {
	new DurableStore(dir, "assistant-rules").saveChecked({
		v: 1,
		watchers: {
			github: {
				rules: [stale, rule("tail", "mention", "inbox", { revision: 1 })],
				otherwise: { action: "wake", revision: 0 },
				revision: 4,
			},
		},
	});
}

describe("a watcher's rules", () => {
	it("decide by the first rule whose every condition holds, case aside, and anything else takes the fallback", () => {
		const rules: AssistantWatcherRules = {
			rules: [
				rule("a", "Review_Requested", "wake"),
				{
					id: "b",
					conditions: [
						{ field: "reason", test: "is_not", value: "subscribed" },
						{ field: "repository", test: "contains", value: "atelier" },
					],
					action: "inbox",
					revision: 1,
				},
			],
			otherwise: { action: "wake", revision: 1 },
			revision: 4,
		};

		expect(decideEvent(rules, SPECS, { reason: "review_requested", repository: "x/y" })).toBe("wake");
		expect(decideEvent(rules, SPECS, { reason: "mention", repository: "atelier/app" })).toBe("inbox");
		expect(decideEvent(rules, SPECS, { reason: "subscribed", repository: "atelier/app" })).toBe("wake");
	});

	it("match a choice by its exact value, a value outside the set by what it is, and fail every test on a missing field", () => {
		const rules: AssistantWatcherRules = {
			rules: [
				rule("review", "review_requested", "wake"),
				{
					id: "other",
					conditions: [{ field: "reason", test: "is_not", value: "mention" }],
					action: "inbox",
					revision: 1,
				},
			],
			otherwise: { action: "wake", revision: 1 },
			revision: 2,
		};

		expect(decideEvent(rules, CHOICES, { reason: "review_requested" })).toBe("wake");
		expect(decideEvent(rules, CHOICES, { reason: "Review_Requested" })).toBe("inbox");
		expect(decideEvent(rules, CHOICES, { reason: "ci_new" })).toBe("inbox");
		expect(decideEvent(rules, CHOICES, { repository: "atelier/app" })).toBe("wake");
		const padded = { ...rules, rules: [rule("pad", " mention ", "inbox")] };
		expect(decideEvent(padded, CHOICES, { reason: "mention" })).toBe("inbox");
	});

	it("refuse a choice outside the set, a test its kind does not take, and a blank value", () => {
		const rules = choiceStore();
		const contains: AssistantRule = {
			...rule("a", "mention", "inbox"),
			conditions: [{ field: "reason", test: "contains", value: "ment" }],
		};
		const blank: AssistantRule = {
			...rule("a", "mention", "inbox"),
			conditions: [{ field: "repository", test: "is", value: "   " }],
		};

		expect(rules.putRule("github", rule("a", "nope", "inbox")).stored).toBe(false);
		expect(rules.putRule("github", contains).stored).toBe(false);
		expect(rules.putRule("github", blank).stored).toBe(false);
		expect(rules.putRule("github", rule("a", "mention", "inbox")).stored).toBe(true);
	});

	it("keep a stored rule the fields no longer take, marked invalid and skipped, until a put repairs it in place", () => {
		const dir = freshDir();
		seedStale(dir, rule("stale", "retired_reason", "inbox", { revision: 3 }));
		const rules = choiceStore(dir);
		const held = rules.get("github");

		const refused = rules.putRule("github", rule("stale", "still_retired", "inbox", { revision: 3 }));
		const repaired = rules.putRule("github", rule("stale", "review_requested", "inbox", { revision: 3 }));

		expect(held.rules.map((kept) => kept.id)).toEqual(["stale", "tail"]);
		expect(decideEvent(held, CHOICES, { reason: "retired_reason" })).toBe("wake");
		expect(refused.stored).toBe(false);
		expect(refused.invalid).toEqual([{ id: "stale", reason: expect.stringContaining("retired_reason") }]);
		expect(repaired).toMatchObject({ stored: true, invalid: [] });
		expect(repaired.rules.rules.map((kept) => [kept.id, kept.revision])).toEqual([
			["stale", 4],
			["tail", 1],
		]);
	});

	it("store one rule at a time, each at its own revision, and refuse a stale edit with the held rules", () => {
		const rules = rulesStore();
		rules.putRule("github", rule("a", "mention", "wake"));
		rules.putRule("github", rule("b", "subscribed", "inbox"));

		// Both opened at list revision 2; edits to two rules do not collide.
		const editA = rules.putRule("github", rule("a", "mention", "inbox", { revision: 1 }));
		const editB = rules.putRule("github", rule("b", "subscribed", "wake", { revision: 1 }));
		const staleA = rules.putRule("github", rule("a", "mention", "wake", { revision: 1 }));

		expect(editA.stored && editB.stored).toBe(true);
		expect(staleA).toMatchObject({ stored: false, rules: { revision: 4 } });
		expect(staleA.rules.rules.map((held) => [held.id, held.action, held.revision])).toEqual([
			["a", "inbox", 2],
			["b", "wake", 2],
		]);
	});

	it("answer a retry whose first answer was lost as stored, without writing again", () => {
		const rules = rulesStore();
		const added = rule("a", " subscribed ", "inbox");

		rules.putRule("github", added);
		const retried = rules.putRule("github", added);
		const other = rules.putRule("github", rule("a", "mention", "inbox"));

		expect(retried).toMatchObject({ stored: true, rules: { revision: 1 } });
		expect(other.stored).toBe(false);
		expect(rules.get("github").rules).toEqual([
			{
				id: "a",
				conditions: [{ field: "reason", test: "is", value: "subscribed" }],
				action: "inbox",
				revision: 1,
			},
		]);
	});

	it("keep a deleted rule deleted, and answer a repeated delete as done", () => {
		const rules = rulesStore();
		rules.putRule("github", rule("a", "mention", "wake"));

		const deleted = rules.deleteRule("github", "a", 1);
		const again = rules.deleteRule("github", "a", 1);
		const revived = rules.putRule("github", rule("a", "mention", "wake"));
		const edited = rules.putRule("github", rule("a", "mention", "wake", { revision: 1 }));

		expect(deleted.stored && again.stored).toBe(true);
		expect(revived.stored || edited.stored).toBe(false);
		expect(rules.get("github").rules).toEqual([]);
	});

	it("move a rule over the list it was drawn from, answer a repeat as done, and refuse a stale order", () => {
		const rules = rulesStore();
		for (const id of ["a", "b", "c"]) rules.putRule("github", rule(id, id, "inbox"));

		rules.moveRule("github", "c", "a", 3);
		const repeat = rules.moveRule("github", "c", "a", 3);
		// Drawn before the move landed.
		const stale = rules.moveRule("github", "b", "c", 3);
		const gone = rules.moveRule("github", "b", "zzz", 4);

		expect(rules.get("github")).toMatchObject({ revision: 4 });
		expect(rules.get("github").rules.map((held) => held.id)).toEqual(["c", "a", "b"]);
		expect(repeat.stored).toBe(true);
		expect(stale).toMatchObject({ stored: false, rules: { revision: 4 } });
		expect(gone.stored).toBe(false);
	});

	it("refuse a rule on a field the watcher lacks, an unknown watcher, and a write that fails", () => {
		let fail = false;
		const dir = freshDir();
		const disk = new DurableStore(dir, "assistant-rules");
		const flaky = Object.assign(Object.create(disk), {
			saveChecked(state: unknown) {
				if (fail) throw new Error("disk full");
				disk.saveChecked(state);
			},
		}) as DurableStore;
		const rules = rulesStore(dir, flaky);
		const label: AssistantRule = {
			...rule("a", "x", "inbox"),
			conditions: [{ field: "label", test: "is", value: "x" }],
		};

		fail = true;
		const failed = rules.putRule("github", rule("a", "x", "inbox"));

		expect(rules.putRule("github", label).stored).toBe(false);
		expect(rules.putRule("gitlab", rule("a", "x", "inbox")).stored).toBe(false);
		expect(failed).toMatchObject({ stored: false, rules: { revision: 0 } });
		expect(rulesStore(dir).get("github")).toMatchObject({ rules: [], revision: 0 });
	});

	it("refuse a stored file with a key its rules do not declare", () => {
		const dir = freshDir();
		const odd = {
			...rule("a", "x", "inbox", { revision: 1 }),
			conditions: [{ field: "reason", test: "is", value: "x", extra: 1 }],
		};
		new DurableStore(dir, "assistant-rules").saveChecked({
			v: 1,
			watchers: { github: { rules: [odd], otherwise: { action: "inbox", revision: 0 }, revision: 1 } },
		});

		expect(() => rulesStore(dir)).toThrow();
	});

	it("start fresh over a file that names one rule id twice", () => {
		const dir = freshDir();
		const twice = rule("a", "x", "inbox", { revision: 1 });
		new DurableStore(dir, "assistant-rules").saveChecked({
			v: 1,
			watchers: { github: { rules: [twice, twice], otherwise: { action: "inbox", revision: 0 }, revision: 2 } },
		});

		expect(rulesStore(dir).get("github").rules).toEqual([]);
	});

	it("read an older file without its drops and pings, keeping the rest in order at their revisions", () => {
		const dir = freshDir();
		new DurableStore(dir, "assistant-rules").saveChecked({
			v: 1,
			watchers: {
				github: {
					rules: [
						{ ...rule("a", "mention", "wake", { revision: 3 }), ping: true },
						rule("b", "subscribed", "drop" as never, { revision: 2 }),
						rule("c", "review", "inbox", { revision: 1 }),
					],
					otherwise: { action: "drop", ping: false, revision: 4 },
					revision: 9,
				},
			},
		});

		expect(rulesStore(dir).get("github")).toEqual({
			rules: [rule("a", "mention", "wake", { revision: 3 }), rule("c", "review", "inbox", { revision: 1 })],
			otherwise: { action: "inbox", revision: 4 },
			revision: 10,
		});
	});

	it("take an older phone's write with its ping stripped, and refuse its drop", () => {
		const put = (action: string) =>
			ConsoleOpSchema.safeParse({
				kind: "assistant_rule_put",
				watcherId: "github",
				rule: { ...rule("a", "mention", "wake"), action, ping: true },
			});

		const pinged = put("wake");
		const dropped = put("drop");

		expect(pinged.success && pinged.data.kind === "assistant_rule_put" ? pinged.data.rule : null).toEqual(
			rule("a", "mention", "wake"),
		);
		expect(dropped.success).toBe(false);
		expect(dropped.error?.message).toContain("update the app");
	});

	it("preview over the live first page, from the rule's place, and refuse what a put refuses", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const assistant = stage(
			freshDir(),
			listing([event("1", "subscribed", 2), event("2", "mention", 3), event("3", "mention", 1)]),
			ambient,
		);
		await assistant.console.place("~/notes");
		assistant.start();
		await assistant.console.putRule("github", rule("subs", "subscribed", "inbox"));
		const atelier: AssistantRule = {
			id: "atelier",
			conditions: [{ field: "repository", test: "contains", value: "ATELIER" }],
			action: "wake",
			revision: 0,
		};

		const last = await assistant.console.previewRule("github", atelier);
		const unknown = assistant.console.previewRule("github", {
			...atelier,
			conditions: [{ field: "label", test: "is", value: "x" }],
		});

		expect(last).toEqual({ decided: 2, shadowed: 1, of: 3, titles: ["mention 2", "mention 3"] });
		await expect(unknown).rejects.toThrow();
		const done = assistant.stop();
		await ambient.advance(5_000);
		await done;
	});

	it("answer the phone with each spec kind, the derived fields and the invalid rule, and refuse a spec of no kind", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		seedStale(dir, rule("stale", "retired_reason", "inbox", { revision: 3 }));
		const assistant = stage(dir, listing([], CHOICES), ambient);

		const answered = AssistantWatcherSchema.parse(assistant.console.state().watchers[0]);

		expect(answered.fieldSpecs?.map((spec) => spec.kind)).toEqual(["enumeration", "text"]);
		expect(answered.fields).toEqual(["reason", "repository"]);
		expect(answered.invalid).toEqual([{ id: "stale", reason: expect.stringContaining("retired_reason") }]);
		expect(AssistantFieldSpecSchema.safeParse({ kind: "number", field: "n", label: "N" }).success).toBe(false);
		expect(
			AssistantFieldSpecSchema.safeParse({ kind: "enumeration", field: "n", label: "N", options: [] }).success,
		).toBe(false);
	});

	it("preview past an invalid earlier rule, which neither decides nor shadows", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		seedStale(dir, {
			id: "stale",
			conditions: [{ field: "reason", test: "is_not", value: "retired_reason" }],
			action: "inbox",
			revision: 3,
		});
		const watcher = listing([event("1", "mention", 2), event("2", "review_requested", 3)], CHOICES);
		const assistant = stage(dir, watcher, ambient);
		await assistant.console.place("~/notes");
		assistant.start();

		const preview = await assistant.console.previewRule("github", rule("reviews", "review_requested", "wake"));

		expect(preview).toMatchObject({ decided: 1, shadowed: 0, of: 2 });
		const done = assistant.stop();
		await ambient.advance(5_000);
		await done;
	});
});
