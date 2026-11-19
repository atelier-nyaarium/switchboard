import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Source, SourceEvent } from "../gateway/assistant/source.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { VAULT_PUBLIC_TITLE_KIND, VAULT_VALUE_KIND, vaultAadKind } from "../shared/content-envelope.js";
import {
	type AutomationInput,
	AutomationSchema,
	type ConsoleAutomationListResult,
} from "../shared/schemasAutomation.js";
import type { ConsoleAutomationSaveResult } from "../shared/schemasAutomationSave.js";
import { FunctionSchema } from "../shared/schemasFunction.js";
import { composeSessionName } from "../shared/session-id.js";
import { eventAutomation } from "../testing/assistantAutomations.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const SENSOR = "ce:1c:44:06:3c:5e";
/** About 24 C, -5 C. */
const WARM = { name: "GVH5110_3C5E", data: { "1": "010103bac864" }, services: ["ec88"] };
const COLD = { name: "GVH5110_3C5E", data: { "1": "010180d16c5a" }, services: ["ec88"] };
const KEY = "k3y-for-tests";

describe("automations beside a stored function", () => {
	let h: FederationHarness;
	const attached = new Map<string, FakeSession>();
	const posted: { url: string; body: unknown }[] = [];
	let polls = 0;
	const event = (id: string, at: number): SourceEvent => ({
		id,
		at,
		title: `mention ${id}`,
		fields: { kind: "mention" },
	});
	const source: Source = {
		id: "fake",
		label: "Fake source",
		fieldSpecs: [{ kind: "text", field: "kind", label: "Kind" }],
		poll: async () => {
			polls += 1;
			const events = polls === 1 ? [event("e0", 1)] : [event("e1", 2), event("e0", 1)];
			return { kind: "events", events, cursor: `c${polls}`, capped: false, nextPollMs: 60_000 };
		},
		list: async () => ({ events: [], here: "0" }),
	};

	beforeAll(async () => {
		h = await startFederationHarness({
			assistantSources: [source],
			wakeTimeoutMs: 2_000,
			fetch: async (url, init) => {
				posted.push({ url, body: JSON.parse(String(init.body)) });
				return new Response(null, { status: 200 });
			},
		});
		const attach = (team: string, sessionToken: string | undefined) => {
			if (attached.has(team)) return;
			attached.set(
				team,
				attachFakeSession(h.gateway, {
					team,
					conversationId: `conv-${team.replaceAll(".", "-")}`,
					sessionToken,
				}),
			);
		};
		h.host.handlers.onCreateSession = (op) =>
			attach(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken);
		h.host.handlers.onWake = (frame) => attach(String(frame.team), frame.sessionToken as string | undefined);
	}, 30_000);
	afterAll(async () => {
		for (const session of attached.values()) session.close();
		if (h) await h.close();
	});

	it("still wakes for the four event automations, tells the crossing, and asks IFTTT for a step inside a function", async () => {
		const mention = { field: "kind", test: "is", value: "mention" } as const;
		const reading = (advert: typeof WARM) =>
			h.phone.value({ kind: "device_reading_post", id: SENSOR, advert, at: h.now() });
		await h.phone.send({
			kind: "vault_put",
			put: {
				id: "ifttt-key",
				expectedRevision: 0,
				sealed: {
					publicTitle: h.phone.seal("IFTTT", vaultAadKind(VAULT_PUBLIC_TITLE_KIND, "ifttt-key")),
					value: h.phone.seal(KEY, vaultAadKind(VAULT_VALUE_KIND, "ifttt-key")),
				},
			},
		});
		await h.phone.value({
			kind: "device_add",
			mac: SENSOR,
			name: "Freezer",
			radio: "phones",
			definition: "govee-h5110",
			advert: WARM,
		});
		await reading(WARM);
		const current = await h.phone.homeRead();
		const placement = await h.phone.homePut({
			gatewayId: h.set.gateway.id,
			workdirPath: "~/projects/notes",
			carried: {
				approveEverySend: true,
				watchers: [{ id: "fake", grant: null }],
				automations: ["one", "two", "three", "four"].map((id) => ({
					id,
					automation: eventAutomation("fake", [mention]),
				})),
			},
			baseVersion: current.record?.version ?? 0,
		});
		const version = placement.record?.version;
		await h.waitFor(async () => {
			const answer = await h.phone.homeRead();
			return answer.record?.version === version && answer.report?.outcome === "placed" ? answer : undefined;
		}, "the placed home report");
		await h.phone.value({ kind: "assistant_source_grants", sourceId: "ifttt", entryIds: ["ifttt-key"] });
		const frost: AutomationInput = {
			enabled: true,
			trigger: {
				kind: "crossing",
				device: SENSOR,
				measure: "temperature",
				direction: "below",
				threshold: 0,
				deadZone: 0.5,
				coolDownSec: 0,
			},
			actions: [{ kind: "tell_assistant", when: "quietly" }],
		};
		await h.phone.value({
			kind: "automation_put",
			automationId: "frost",
			automation: AutomationSchema.parse(frost),
			baseRevision: 0,
		});
		const saved = (
			await h.phone.value({
				kind: "automation_save",
				automationId: "chime",
				automation: AutomationSchema.parse({
					enabled: true,
					trigger: { kind: "event", source: "fake", conditions: [mention] },
					actions: [{ kind: "run_function", function: "bell" }],
				} satisfies AutomationInput),
				automationBase: 0,
				function: {
					as: "edit",
					id: "bell",
					base: 0,
					body: FunctionSchema.parse({
						name: "Bell",
						params: [],
						steps: [
							{
								kind: "do",
								action: "ifttt_trigger",
								args: {
									event: { kind: "literal", value: "bell" },
									value1: { kind: "literal", value: "rang" },
								},
							},
						],
					}),
				},
				confirmed: true,
			})
		).result as ConsoleAutomationSaveResult;

		await h.waitFor(() => polls >= 1, "the backlog poll");
		await reading(COLD);
		const stamped = await h.waitFor(async () => {
			await h.phone.value({ kind: "assistant_source_grants", sourceId: "fake", entryIds: [] });
			const { automations } = (await h.phone.value({ kind: "automation_list" }))
				.result as ConsoleAutomationListResult;
			return automations.every((row) => row.lastRanAt !== undefined) && posted.length > 0
				? automations
				: undefined;
		}, "every automation to run");

		expect(saved).toMatchObject({ stored: true, function: { id: "bell", users: ["chime"], moves: true } });
		expect(stamped.map((row) => row.id)).toEqual(["one", "two", "three", "four", "frost", "chime"]);
		expect(posted).toEqual([
			{ url: `https://maker.ifttt.com/trigger/bell/with/key/${KEY}`, body: { value1: "rang" } },
		]);
		expect(attached.get(ASSISTANT_TEAM)?.inbound.filter((frame) => frame.event === true)).toHaveLength(1);
	});

	it("carries a function by value with the automations a move takes, keeping the one left behind unlisted", async () => {
		const current = await h.phone.homeRead();
		const placement = await h.phone.homePut({
			gatewayId: h.set.gateway.id,
			workdirPath: "~/projects/notes",
			carried: {
				approveEverySend: true,
				watchers: [{ id: "fake", grant: null }],
				automations: [
					{
						id: "gong",
						automation: AutomationSchema.parse({
							enabled: true,
							trigger: { kind: "event", source: "fake", conditions: [] },
							actions: [{ kind: "run_function", function: "gong-fn" }],
						} satisfies AutomationInput),
					},
				],
				functions: [
					{
						id: "gong-fn",
						function: FunctionSchema.parse({
							name: "Gong",
							params: [],
							steps: [
								{
									kind: "do",
									action: "tell_assistant",
									args: { when: { kind: "literal", value: "now" } },
								},
							],
						}),
					},
				],
			},
			baseVersion: current.record?.version ?? 0,
		});
		const version = placement.record?.version;
		await h.waitFor(async () => {
			const answer = await h.phone.homeRead();
			return answer.record?.version === version && answer.report?.outcome === "placed" ? answer : undefined;
		}, "the placed home report");
		const listed = (await h.phone.value({ kind: "automation_list" })).result as ConsoleAutomationListResult;

		expect(listed.automations.map((row) => [row.id, row.invalid])).toEqual([
			["frost", undefined],
			["gong", undefined],
		]);
		expect(listed.functions?.map((row) => [row.id, row.users, row.moves])).toEqual([["gong-fn", ["gong"], true]]);
	});
});
