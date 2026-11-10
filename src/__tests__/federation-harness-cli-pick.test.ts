import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_REFUSED_REASON } from "../gateway/routines/reservation.js";
import { cliRefusalText } from "../shared/cli-resolve.js";
import { type SendRefusal, sendRefusalText } from "../shared/launch-notice.js";
import type { ContainerState } from "../shared/schemasPresence.js";
import type { Routine } from "../shared/schemasRoutine.js";
import type { Runbook, RunbookFireTarget } from "../shared/schemasRunbook.js";
import type { GatewaySpawnPoints, TeamInfo } from "../shared/types.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const PROJECT = "fixture-app";

describe("a create's CLI, picked where the Gateway knows what a spawn point runs", () => {
	let h: FederationHarness;
	let asker: FakeSession;
	const attached: FakeSession[] = [];
	const wakeAnswer: { value: "launched" | "silent" } = { value: "launched" };

	const containers = (list: ContainerState[]) => h.host.sendFrame({ type: "containers", containers: list });
	const send = async (to: string, extra: Record<string, unknown> = {}) => {
		const response = await asker.post("/send", {
			from: asker.team,
			fromConversationId: asker.conversationId,
			to,
			body: "hello",
			...extra,
		});
		return { status: response.status, json: (await response.json()) as Record<string, unknown> };
	};
	const spawnPoints = async (): Promise<GatewaySpawnPoints | undefined> => {
		const { planes } = await h.phone.planesRead({});
		const payload = planes.find((plane) => plane.name === "presence")?.payload as
			| { spawnPoints?: GatewaySpawnPoints[] }
			| undefined;
		return payload?.spawnPoints?.find((point) => point.gatewayId === h.set.gateway.id);
	};

	beforeAll(async () => {
		h = await startFederationHarness({
			host: {
				spawnLists: { harnessSpawns: { claude: ["host"], opencode: ["host"], copilot: [] } },
				answerWake: () => wakeAnswer.value,
			},
		});
		asker = attachFakeSession(h.gateway, { team: `${PROJECT}.asker`, conversationId: "conv-asker" });
		attached.push(asker);
		await asker.ready();
	}, 30_000);
	afterAll(async () => {
		for (const session of attached) session.close();
		if (h) await h.close();
	});
	afterEach(() => {
		wakeAnswer.value = "launched";
	});

	it.each<[string, Record<string, unknown>, SendRefusal]>([
		["none named, none installed", { displayLabel: "New" }, { kind: "cli", refusal: { cause: "none_installed" } }],
		[
			"a CLI named that is not installed",
			{ displayLabel: "New", cli: "claude" },
			{ kind: "cli", refusal: { cause: "not_installed", available: [] } },
		],
		["no label for a session that does not exist", {}, { kind: "no_label" }],
	])("refuses a create at once, typed, launching nothing: %s", async (_label, extra, refused) => {
		containers([{ project: PROJECT, state: "running", clis: [] }]);
		const wakes = h.host.wakes.length;
		const to = `${PROJECT}.ghost`;

		const answer = await send(to, extra);

		expect(answer.status).toBe(404);
		expect(answer.json).toMatchObject({ refused, error: sendRefusalText(refused, h.target(to)) });
		expect(h.host.wakes).toHaveLength(wakes);
	});

	it("refuses a CLI the place never runs, whatever it has installed", async () => {
		containers([{ project: PROJECT, state: "running", clis: ["claude"] }]);
		const wakes = h.host.wakes.length;

		const answer = await send(`${PROJECT}.ghost`, { displayLabel: "New", cli: "copilot" });

		expect(answer.json).toMatchObject({ refused: { kind: "cli", refusal: { cause: "refused" } } });
		expect(h.host.wakes).toHaveLength(wakes);
	});

	/** A create into a container that has not said what it runs, its launch still going. */
	const pendingCreate = async (name: string) => {
		containers([{ project: PROJECT, state: "running" }]);
		wakeAnswer.value = "silent";
		const answer = await send(`${PROJECT}.${name}`, { displayLabel: name });
		const wake = await h.waitFor(
			() => h.host.wakes.find((frame) => answer.json.target === h.target(String(frame.team))),
			"the wake",
		);
		return { answer, wake, team: String(wake.team) };
	};

	it("leaves the pick to a container that has not said, and takes the daemon's word before the session registers", async () => {
		const { answer, wake, team } = await pendingCreate("pending");
		h.host.sendFrame({ type: "wake_stage", team, stage: "cli_found", harness: "claude" });
		const woken = attachFakeSession(h.gateway, {
			team,
			conversationId: "conv-pending",
			sessionToken: wake.sessionToken as string,
		});
		attached.push(woken);
		await h.waitFor(() => woken.inbound.find((frame) => frame.body === "hello"), "the queued message");
		const watched = await h.waitFor(
			() =>
				h.host.frames
					.flatMap((frame) =>
						frame.type === "presence_watch"
							? (frame.watch as Array<{ team: string; harness?: string }>)
							: [],
					)
					.find((entry) => entry.team === team),
			"the daemon's watch of the session",
		);

		expect(answer.json).toMatchObject({ status: "starting" });
		expect(wake.harness).toBe("unpicked");
		expect(watched.harness).toBe("claude");
	});

	it("tells the phone a create is launching, and the CLI the daemon found, before it registers", async () => {
		const { team } = await pendingCreate("unnamed");
		const rowOf = async () => {
			const { planes } = await h.phone.planesRead({});
			const payload = planes.find((plane) => plane.name === "presence")?.payload as
				| { rows?: TeamInfo[] }
				| undefined;
			return payload?.rows?.find((held) => held.team === team);
		};
		const launching = await h.waitFor(rowOf, "the launching row");
		h.host.sendFrame({ type: "wake_stage", team, stage: "cli_found", harness: "claude" });
		const named = await h.waitFor(async () => {
			const row = await rowOf();
			return row?.harness ? row : undefined;
		}, "the row naming its CLI");

		expect(launching.status).toBe("verifying");
		expect(named).toMatchObject({ status: "verifying", harness: "claude" });
	});

	it("tells a session each spawn point's CLIs where known, and the phone each container's state", async () => {
		containers([{ project: PROJECT, state: "stopped", clis: ["claude"] }]);

		const discovered = (await (await asker.get("/discover?coverage=1")).json()) as {
			spawnClis?: Array<{ spawn: string; clis: string[] }>;
		};
		const point = await h.waitFor(async () => {
			const row = await spawnPoints();
			return row?.containers?.some((held) => held.state === "stopped") ? row : undefined;
		}, "the containers in the spawn points");

		expect(discovered.spawnClis?.map(({ spawn, clis }) => ({ spawn, clis }))).toEqual([
			{ spawn: "host", clis: ["claude", "opencode"] },
			{ spawn: PROJECT, clis: ["claude"] },
		]);
		expect(point.containers).toEqual([{ project: PROJECT, state: "stopped", clis: ["claude"] }]);
	});

	it("starts and stops a container on the daemon, and refuses a host shell", async () => {
		const ops = h.host.ops.length;

		const started = await h.phone.value({ kind: "container_start", target: h.target(PROJECT) });
		const stopped = await h.phone.value({ kind: "container_stop", target: h.target(PROJECT) });
		const host = await h.phone.value({ kind: "container_start", target: h.target("host") });

		expect([started.result, stopped.result]).toEqual([{ accepted: true }, { accepted: true }]);
		expect(host.result).toMatchObject({ kind: "refusal" });
		expect(h.host.ops.slice(ops)).toEqual([
			expect.objectContaining({ kind: "containerStart", project: PROJECT }),
			expect.objectContaining({ kind: "containerStop", project: PROJECT }),
		]);
	});

	describe("a fire's and a routine's new session", () => {
		const book: Runbook = { id: "pick", name: "Pick", body: "do the thing", parameters: [], revision: 1 };
		const fire = async (into: RunbookFireTarget) =>
			(await h.phone.value({ kind: "runbook_fire", runbookId: book.id, values: {}, into })).result as {
				fired: boolean;
				reason?: string;
			};

		beforeAll(async () => {
			await h.phone.value({ kind: "runbook_put", runbook: book });
		});

		it("does not fire when its CLI does not fit, and says why", async () => {
			const creates = h.host.ops.filter((op) => op.kind === "createSession").length;

			const several = await fire({ kind: "new", target: h.target("host") });
			const missing = await fire({ kind: "new", target: h.target("host"), cli: "copilot" });

			expect(several).toEqual({
				fired: false,
				reason: cliRefusalText({ cause: "needs_pick", available: ["claude", "opencode"] }, "host"),
			});
			expect(missing).toMatchObject({ fired: false, reason: expect.any(String) });
			expect(h.host.ops.filter((op) => op.kind === "createSession")).toHaveLength(creates);
		});

		it("stops a routine run for review when its CLI does not fit", async () => {
			const routine: Routine = {
				id: "picky",
				name: "Picky",
				weekdays: [1],
				weekInterval: 1,
				startDate: "2026-09-07",
				time: "09:00",
				zone: "America/Los_Angeles",
				runbookId: book.id,
				approvedRevision: 1,
				values: {},
				target: { spawn: "host", cli: "copilot" },
				linkedEntries: [],
				forgetAfterDays: 7,
				enabled: true,
				revision: 1,
				since: 0,
			};
			await h.phone.value({ kind: "routine_put", routine });

			await h.phone.value({ kind: "routine_run", routineId: routine.id });
			const state = await h.waitFor(async () => {
				const { result } = await h.phone.value({ kind: "routine_list" });
				const held = (result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
					(row) => row.routine.id === routine.id,
				);
				return held?.reviewReason ? held : undefined;
			}, "the review");

			expect(state.reviewReason).toBe(CLI_REFUSED_REASON);
		});
	});
});
