import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Source, SourceEvent } from "../gateway/assistant/source.js";
import {
	type AssistantHomePort,
	type AssistantStage,
	type AssistantVault,
	composeAssistant,
} from "../gateway/compose/composeAssistant.js";
import type { ComputedFields } from "../gateway/computed/computedFields.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { AssistantSourceSchema } from "../shared/schemasAssistant.js";
import type { AssistantHomeRecord, AssistantHomeSealed } from "../shared/schemasAssistantHome.js";
import { type AssistantFieldSpec, AssistantFieldSpecSchema, conditionsMatch } from "../shared/schemasAssistantRules.js";
import { AUTOMATIONS_MAX, type AutomationCondition, type AutomationInput } from "../shared/schemasAutomation.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";
import { SessionStore } from "../shared/session-store.js";
import { bandField, boundAutomations, eventAutomation } from "../testing/assistantAutomations.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const LOCAL_GATEWAY = "gateway-local";
const HOME_ENVELOPE: ContentEnvelope = {
	v: 1,
	epoch: 1,
	nonce: Buffer.alloc(12).toString("base64"),
	ciphertext: Buffer.alloc(16).toString("base64"),
};
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-automations-"));
	dirs.push(dir);
	return dir;
};

const reason = (value: string, test: AutomationCondition["test"] = "is"): AutomationCondition[] => [
	{ field: "reason", test, value },
];

const event = (id: string, kind: string, at = 1): SourceEvent => ({
	id,
	at,
	title: `${kind} ${id}`,
	fields: { reason: kind, repository: "atelier/app" },
});

/** Lists `held`; polls nothing new. */
function listing(held: SourceEvent[] = [], fieldSpecs = CHOICES): Source {
	return {
		id: "github",
		label: "GitHub notifications",
		brief: "GitHub",
		fieldSpecs,
		poll: async () => ({ kind: "unchanged", nextPollMs: 60_000 }),
		list: async () => ({ events: held, here: "0" }),
	};
}

const SELF_TOLD: Source = { ...listing([], SPECS), id: "sensors", label: "Sensors", selfTold: true };

function bindHome(
	assistant: AssistantStage,
	store: SessionStore,
	carried: AssistantHomeSealed["carried"] = null,
	reports: string[] = [],
) {
	const sealed: AssistantHomeSealed = { workdirPath: "~/notes", carried };
	assistant.bindHome({
		open: () => ({ kind: "ok", sealed }),
		report: async (mark) => {
			reports.push(mark.outcome);
			return "accepted";
		},
		endSession: async () => {
			store.forget(ASSISTANT_TEAM);
		},
	} satisfies AssistantHomePort);
	return () =>
		assistant.follow(
			{ version: 1, gatewayId: LOCAL_GATEWAY, sealed: HOME_ENVELOPE } satisfies AssistantHomeRecord,
			{
				registered: false,
			},
		);
}

function stage(
	dataDir: string,
	sources: Source[],
	ambient: FakeAmbient,
	carried: AssistantHomeSealed["carried"] = null,
	fields?: ComputedFields,
) {
	const store = new SessionStore({ ambient: processAmbient() });
	const grants = new Map<string, string[]>();
	const vault: AssistantVault = {
		serviceGrants: (id) => grants.get(id) ?? [],
		setServiceGrants: (id, entryIds) => void grants.set(id, entryIds),
		readForService: async () => ({ kind: "released", value: "token" }),
		usableHere: async () => true,
	};
	const assistant = composeAssistant({
		dataDir,
		localGatewayId: LOCAL_GATEWAY,
		domainId: () => "home",
		ambient,
		sessions: { sessionStore: store, presence: store } as never,
		saveSessions: () => {},
		vault,
		routes: () => {
			throw new Error("no Domain");
		},
		blobSize: () => null,
		lastDeliverySeq: () => 0,
		fetch: async () => new Response(null, { status: 304 }),
		sources,
	});
	const automations = boundAutomations(assistant, dataDir, () => ambient.now(), fields);
	const reports: string[] = [];
	return { assistant, automations, grants, reports, followHome: bindHome(assistant, store, carried, reports) };
}

/** Placed, with its lanes running. */
async function placed(
	sources: Source[],
	dir = freshDir(),
	carried: AssistantHomeSealed["carried"] = null,
	fields?: ComputedFields,
) {
	const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
	const test = stage(dir, sources, ambient, carried, fields);
	await test.followHome();
	test.assistant.start();
	const stop = async () => {
		const done = test.assistant.stop();
		await ambient.advance(5_000);
		await done;
	};
	return { ...test, stop };
}

describe("an event automation", () => {
	it("matches text case aside and a choice by its exact value, fails every test on a missing field, and never matches while a condition does not fit", () => {
		expect(conditionsMatch(reason("Review_Requested"), SPECS, { reason: "review_requested" })).toBe(true);
		expect(conditionsMatch(reason("review_requested"), CHOICES, { reason: "Review_Requested" })).toBe(false);
		expect(conditionsMatch(reason(" mention "), CHOICES, { reason: "mention" })).toBe(true);
		expect(conditionsMatch(reason("mention", "is_not"), CHOICES, { reason: "ci_new" })).toBe(true);
		expect(conditionsMatch(reason("mention", "is_not"), CHOICES, { repository: "atelier/app" })).toBe(false);
		expect(conditionsMatch(reason("ment", "contains"), CHOICES, { reason: "mention" })).toBe(false);
		expect(conditionsMatch([], CHOICES, {})).toBe(true);
	});

	it("saves as invalid on a source this Gateway lacks, one whose events tell themselves, and a condition its fields do not take", async () => {
		const { automations, stop } = await placed([listing(), SELF_TOLD]);

		const unknown = automations.ownerPut("a", eventAutomation("gitlab", []), 0);
		const selfTold = automations.ownerPut("b", eventAutomation("sensors", []), 0);
		const outside = automations.ownerPut("c", eventAutomation("github", reason("nope", "contains")), 0);
		const blank = automations.ownerPut("d", eventAutomation("github", reason("   ")), 0);
		const fits = automations.ownerPut("e", eventAutomation("github", reason("mention")), 0);
		await stop();

		expect([unknown, selfTold, outside, blank, fits].map((result) => [result.stored, result.row?.invalid])).toEqual(
			[
				[true, expect.any(String)],
				[true, expect.any(String)],
				[true, expect.any(String)],
				[true, expect.any(String)],
				[true, undefined],
			],
		);
		expect(automations.eventsOf("github").map((held) => held.id)).toEqual(["e"]);
	});

	it("is refused while the assistant lives elsewhere", () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { automations } = stage(freshDir(), [listing()], ambient);

		expect(automations.ownerPut("a", eventAutomation("github", []), 0)).toMatchObject({
			stored: false,
			revision: 0,
		});
	});

	it("lists as its trigger reads, its conditions trimmed, and refuses a stale write with the held row", async () => {
		const { automations, stop } = await placed([listing()]);
		const quiet = eventAutomation("github", reason("mention"), "quietly");

		const added = automations.ownerPut(
			"a",
			eventAutomation("github", [
				...reason(" review_requested "),
				{ field: "repository", test: "contains", value: "atelier" },
			]),
			0,
		);
		const every = automations.ownerPut("b", eventAutomation("github", []), 0);
		const stale = automations.ownerPut("a", quiet, 0);
		const edited = automations.ownerPut("a", quiet, 1);
		await stop();

		expect(added.row).toMatchObject({
			revision: 1,
			sentence: "GitHub: reason is review requested and repository contains atelier",
			automation: { trigger: { conditions: [{ value: "review_requested" }, { value: "atelier" }] } },
		});
		expect(every.row?.sentence).toBe("GitHub: every event");
		expect(stale).toMatchObject({ stored: false, revision: 1, row: { sentence: added.row?.sentence } });
		expect(edited).toMatchObject({ stored: true, revision: 2, row: { sentence: "GitHub: reason is mention" } });
	});

	it("stays held when its source drops a field it tests, listed invalid, and runs on with a warning when a choice leaves the list", async () => {
		const dir = freshDir();
		const first = await placed([listing()], dir);
		const listed: AutomationCondition[] = [{ field: "reason", test: "is", value: ["mention", "assign"] }];
		const choice = eventAutomation("github", listed);
		first.automations.ownerPut("a", choice, 0);
		first.automations.ownerPut(
			"b",
			eventAutomation("github", [{ field: "repository", test: "is", value: "x" }]),
			0,
		);
		const check = first.automations.checkOp({ automationId: "c", automation: choice, automationBase: 0 });
		await first.stop();
		const narrowed: AssistantFieldSpec[] = [
			{
				kind: "enumeration",
				field: "reason",
				label: "Reason",
				options: [{ value: "assign", label: "Assigned" }],
			},
		];

		const { automations, stop } = await placed([listing([], narrowed)], dir);
		const rows = automations.rows();
		const armed = automations.eventsOf("github").map((held) => held.id);
		await stop();

		expect(rows.map((row) => [row.id, row.invalid === undefined, row.sentence])).toEqual([
			["a", true, "GitHub: reason is any of mention, assigned"],
			["b", false, "GitHub: repository is x"],
		]);
		expect(armed).toEqual(["a"]);
		expect(check).toMatchObject({ ready: true, issues: [{ level: "warning", record: "automation" }] });
		expect(
			[{ reason: "mention" }, { reason: "assign" }].map((fields) => conditionsMatch(listed, narrowed, fields)),
		).toEqual([false, true]);
	});

	it("takes every carried automation, one it cannot run listed invalid, each stored without the null a phone sealed for its label", async () => {
		const { automations, stop } = await placed([listing()], freshDir(), {
			approveEverySend: true,
			watchers: [],
			automations: [
				{ id: "unfit", automation: eventAutomation("github", reason("retired", "contains_not")) },
				{ id: "lost", automation: eventAutomation("mail", []) },
				{ id: "sealed", automation: { ...eventAutomation("github", reason("mention")), label: null } },
			],
		});
		const rows = new Map(automations.rows().map((row) => [row.id, row]));
		await stop();

		expect([...rows].map(([id, row]) => [id, row.invalid === undefined])).toEqual([
			["unfit", false],
			["lost", false],
			["sealed", true],
		]);
		expect(rows.get("sealed")?.automation).toEqual(eventAutomation("github", reason("mention")));
	});

	it("refuses a move whose automations do not fit before anything of the old placement is touched", async () => {
		const many = Array.from({ length: AUTOMATIONS_MAX + 1 }, (_, at) => ({
			id: `e${at}`,
			automation: eventAutomation("github", []),
		}));
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const test = stage(freshDir(), [listing()], ambient, {
			approveEverySend: true,
			watchers: [],
			automations: many,
		});
		test.grants.set("github", ["pat"]);

		await test.followHome();

		expect(test.reports).toEqual(["refused"]);
		expect(test.grants.get("github")).toEqual(["pat"]);
		expect(test.automations.rows()).toEqual([]);
	});

	it("starts unrun again once a move replaced it, and a move spares an automation that stays on its Gateway", async () => {
		const { automations, stop } = await placed([listing()], freshDir(), null, bandField("band-a", "ce:1c"));
		const all = { id: "a", automation: eventAutomation("github", []) };
		const watch: AutomationInput = {
			enabled: true,
			trigger: { kind: "value", field: "band-a", becomes: "low", coolDownSec: 0 },
			actions: [{ kind: "tell_assistant", when: "quietly" }],
		};
		automations.ownerPut("watch", watch, 0);
		automations.ownerPut("a", all.automation, 0);
		automations.noteEvents(["a"], T0);
		const ran = automations.rows().find((row) => row.id === "a")?.lastRanAt;

		automations.write({ kind: "carry", rows: [], functions: [] });
		automations.write({ kind: "carry", rows: [all], functions: [] });
		automations.ownerPut("toString", all.automation, 0);
		const edited = automations.ownerPut("watch", { ...watch, enabled: false }, 1);
		const rows = new Map(automations.rows().map((row) => [row.id, row]));
		await stop();

		expect(ran).toBe(T0);
		expect([...rows.keys()].sort()).toEqual(["a", "toString", "watch"]);
		expect([rows.get("a")?.lastRanAt, rows.get("toString")?.lastRanAt]).toEqual([undefined, undefined]);
		expect(rows.get("watch")).toMatchObject({ automation: { enabled: false } });
		expect(edited.stored).toBe(true);
	});

	it("previews over the live first page, newest first, and refuses what a put refuses", async () => {
		const held = [event("1", "subscribed", 2), event("2", "mention", 3), event("3", "mention", 1)];
		const { assistant, stop } = await placed([listing(held, SPECS)]);

		const preview = await assistant.previewTrigger(eventAutomation("github", reason("MENTION")).trigger);
		const unknown = assistant.previewTrigger(
			eventAutomation("github", [{ field: "label", test: "is", value: "x" }]).trigger,
		);

		expect(preview).toEqual({
			matched: 2,
			of: 3,
			matches: [
				{ title: "mention 2", at: 3 },
				{ title: "mention 3", at: 1 },
			],
		});
		await expect(unknown).rejects.toThrow();
		await stop();
	});

	it("answers the phone each spec kind, and refuses a spec of no kind", () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const { assistant } = stage(freshDir(), [listing()], ambient);

		const answered = AssistantSourceSchema.parse(assistant.console.state().sources?.[0]);

		expect(answered.fieldSpecs.map((spec) => spec.kind)).toEqual(["enumeration", "text"]);
		expect(AssistantFieldSpecSchema.safeParse({ kind: "future_kind", field: "n", label: "N" }).success).toBe(false);
		expect(
			AssistantFieldSpecSchema.safeParse({ kind: "enumeration", field: "n", label: "N", options: [] }).success,
		).toBe(false);
		const padded = { kind: "enumeration", field: "n", label: "N", options: [{ value: " a ", label: "A" }] };
		expect(AssistantFieldSpecSchema.safeParse(padded).success).toBe(false);
	});
});

describe("a let-go", () => {
	it("leaves no event automation when the home moves away, one of a source this build lost included", async () => {
		const dir = freshDir();
		const mail: Source = { ...listing([], SPECS), id: "mail", label: "Mail" };
		const first = await placed([listing(), mail], dir);
		first.automations.ownerPut("g", eventAutomation("github", reason("mention")), 0);
		first.automations.ownerPut("m", eventAutomation("mail", []), 0);
		await first.stop();
		const { assistant, automations, stop } = await placed([listing()], dir);
		const held = automations.rows().map((row) => row.id);

		await assistant.follow(
			{ version: 2, gatewayId: "elsewhere", sealed: HOME_ENVELOPE } satisfies AssistantHomeRecord,
			{ registered: false },
		);
		await stop();

		expect(held.sort()).toEqual(["g", "m"]);
		expect(automations.rows()).toEqual([]);
	});
});
