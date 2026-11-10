import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CliRefusal } from "../shared/cli-resolve.js";
import {
	type LaunchFailure,
	ownerLaunchLine,
	ownerLaunchPhrase,
	type SendRefusal,
	sendRefusalText,
} from "../shared/launch-notice.js";
import type { ContainerState } from "../shared/schemasPresence.js";
import { type Routine, routineSessionName } from "../shared/schemasRoutine.js";
import type { Runbook, RunbookFireTarget } from "../shared/schemasRunbook.js";
import { type SessionHarness, UNPICKED_WORD } from "../shared/session-harness.js";
import type { GatewaySpawnPoints, TeamInfo } from "../shared/types.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const PROJECT = "fixture-app";

describe("a create's CLI, picked where the Gateway knows what a spawn point runs", () => {
	let h: FederationHarness;
	let asker: FakeSession;
	const attached: FakeSession[] = [];
	const wakeAnswer: { value: "launched" | "silent" | { failure: LaunchFailure } } = { value: "launched" };

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
		h.host.handlers.failCreateSession = undefined;
		h.host.handlers.onCreateSession = undefined;
	});

	it.each<[string, string, Record<string, unknown>, SendRefusal]>([
		[
			"one named that the running container lacks",
			"ghost-named",
			{ displayLabel: "New", cli: "claude" },
			{ kind: "cli", refusal: { cause: "not_installed", available: ["opencode"], named: "claude" } },
		],
		["no label for a session that does not exist", "ghost-unlabelled", {}, { kind: "no_label" }],
	])("refuses a create at once, typed, launching nothing: %s", async (_label, name, extra, refused) => {
		containers([{ project: PROJECT, state: "running", clis: ["opencode"] }]);
		const wakes = h.host.wakes.length;
		const to = `${PROJECT}.${name}`;

		const answer = await send(to, extra);

		expect(answer.status).toBe(404);
		expect(answer.json).toMatchObject({ refused, error: sendRefusalText(refused, h.target(to)) });
		expect(h.host.wakes).toHaveLength(wakes);
	});

	it.each<[string, SessionHarness[], string]>([
		["leaves an empty list to the launch", [], UNPICKED_WORD],
		["runs OpenCode when it is the only one", ["opencode"], "opencode"],
		["runs Copilot when it is the only one", ["copilot"], "copilot"],
	])("launches an unnamed create in a running container: %s", async (_label, clis, harness) => {
		containers([{ project: PROJECT, state: "running", clis }]);
		const name = `only-${clis.join("-") || "none"}`;

		const answer = await send(`${PROJECT}.${name}`, { displayLabel: name });
		const wake = await h.waitFor(
			() => h.host.wakes.find((frame) => answer.json.target === h.target(String(frame.team))),
			"the wake",
		);

		expect(answer.json).toMatchObject({ status: "starting" });
		expect(wake.harness).toBe(harness);
	});

	/** The CLI the daemon is told to watch a session's pane for. */
	const watchedCli = async (team: string) =>
		(
			await h.waitFor(
				() =>
					h.host.frames
						.flatMap((frame) =>
							frame.type === "presence_watch"
								? (frame.watch as Array<{ team: string; harness?: string }>)
								: [],
						)
						.find((entry) => entry.team === team && entry.harness),
				`the daemon's watch of ${team}`,
			)
		).harness;

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
		h.host.sendFrame({ type: "wake_stage", team, launchId: wake.launchId, stage: "cli_found", harness: "claude" });
		const woken = attachFakeSession(h.gateway, {
			team,
			conversationId: "conv-pending",
			sessionToken: wake.sessionToken as string,
		});
		attached.push(woken);
		await h.waitFor(() => woken.inbound.find((frame) => frame.body === "hello"), "the queued message");

		expect(answer.json).toMatchObject({ status: "starting" });
		expect(wake.harness).toBe("unpicked");
		expect(await watchedCli(team)).toBe("claude");
	});

	it("takes Copilot and its session id from a container's launch, and types into its pane there", async () => {
		const { wake, team } = await pendingCreate("copilot");
		const sessionId = "0b6c5e1a-2f4d-4c8e-9a1b-3d5e7f9a1c2e";
		h.host.sendFrame({
			type: "wake_stage",
			team,
			launchId: wake.launchId,
			stage: "cli_found",
			harness: "copilot",
			sessionId,
		});
		h.host.sendFrame({ type: "wake_result", team, launchId: wake.launchId, success: true });
		const woken = attachFakeSession(h.gateway, {
			team,
			conversationId: "conv-copilot",
			sessionToken: wake.sessionToken as string,
			harness: "copilot",
		});
		attached.push(woken);
		await h.waitFor(() => woken.inbound.find((frame) => frame.body === "hello"), "the queued message");
		const ops = h.host.ops.length;
		const typed = await woken.post("/session/type", { text: "<channel>typed</channel>" });

		expect(wake.harness).toBe(UNPICKED_WORD);
		expect(h.gateway.faults.sessionRecord(team)).toMatchObject({ harness: "copilot", mintedSessionId: sessionId });
		expect(typed.status).toBe(200);
		expect(h.host.ops.slice(ops)).toEqual([
			expect.objectContaining({
				kind: "typeIntoPane",
				target: { kind: "devcontainer", name: PROJECT, sessionName: team.slice(PROJECT.length + 1) },
			}),
		]);
	});

	it.each<[SessionHarness, string | undefined, TeamInfo["status"]]>([
		["copilot", "5f0a9c3e-7b2d-4e1f-8a6c-2d4b6e8f0a1c", "online"],
		["claude", undefined, "verifying"],
	])(
		"takes a late %s pick from the launch's result, confirming a plugin only when its CLI has no handshake",
		async (harness, sessionId, settled) => {
			const { wake, team } = await pendingCreate(`late-${harness}`);
			const rowOf = async () => {
				const { planes } = await h.phone.planesRead({});
				const payload = planes.find((plane) => plane.name === "presence")?.payload as
					| { rows?: TeamInfo[] }
					| undefined;
				return payload?.rows?.find((held) => held.team === team);
			};
			const woken = attachFakeSession(h.gateway, {
				team,
				conversationId: `conv-late-${harness}`,
				sessionToken: wake.sessionToken as string,
				harness,
				answersHandshake: false,
			});
			attached.push(woken);
			await woken.registered();
			const before = await h.waitFor(async () => (await rowOf())?.status, "the unpicked row");
			h.host.sendFrame({
				type: "wake_result",
				team,
				launchId: wake.launchId,
				success: true,
				harness,
				...(sessionId ? { sessionId } : {}),
			});
			// Pick and confirm together.
			const after = await h.waitFor(async () => {
				const row = await rowOf();
				return row?.harness === harness ? row : undefined;
			}, "the row naming its CLI");

			expect(before).toBe("verifying");
			expect(after.status).toBe(settled);
			expect(h.gateway.faults.sessionRecord(team)).toMatchObject({
				harness,
				...(sessionId ? { mintedSessionId: sessionId } : {}),
			});
			expect(woken.frames.some((frame) => frame.type === "channel_push" && frame.replyJsonSchema)).toBe(true);
		},
	);

	it("takes a new session's CLI from its plugin when the daemon's word never came", async () => {
		const { wake, team } = await pendingCreate("lost");
		const woken = attachFakeSession(h.gateway, {
			team,
			conversationId: "conv-lost",
			sessionToken: wake.sessionToken as string,
			harness: "claude",
		});
		attached.push(woken);
		await h.waitFor(() => woken.inbound.find((frame) => frame.body === "hello"), "the queued message");

		expect(await watchedCli(team)).toBe("claude");
	});

	it("tells the phone a create is launching, and the CLI the daemon found, before it registers", async () => {
		const { wake, team } = await pendingCreate("unnamed");
		const rowOf = async () => {
			const { planes } = await h.phone.planesRead({});
			const payload = planes.find((plane) => plane.name === "presence")?.payload as
				| { rows?: TeamInfo[] }
				| undefined;
			return payload?.rows?.find((held) => held.team === team);
		};
		const launching = await h.waitFor(rowOf, "the launching row");
		h.host.sendFrame({ type: "wake_stage", team, launchId: wake.launchId, stage: "cli_found", harness: "claude" });
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

	/** A session's owner notice. */
	const ownerNotice = (team: () => string | undefined) =>
		h.waitFor(async () => {
			const from = team();
			if (!from) return undefined;
			return h.phone
				.entries(await h.phone.inboxRead())
				.find((entry) => entry.kind === "notice" && entry.from === h.target(from));
		}, "the owner's launch notice");

	it("answers a create at dispatch, and tells the owner by a titled notice when the daemon finds no CLI", async () => {
		const refusal: CliRefusal = { cause: "needs_pick", available: ["claude", "opencode"] };
		let team: string | undefined;
		h.host.handlers.failCreateSession = (create) => {
			team = create.team;
			return { error: "pick one", failure: { kind: "cli", refusal } };
		};

		const created = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Picky",
			harness: "claude",
		});
		const notice = await ownerNotice(() => team);

		expect(created.result).toMatchObject({ created: true, status: "pending" });
		expect(notice).toMatchObject({ kind: "notice", title: expect.any(String) });
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
			const creates = h.host.creates.length;

			const several = await fire({ kind: "new", target: h.target("host") });
			const missing = await fire({ kind: "new", target: h.target("host"), cli: "copilot" });

			expect(several).toEqual({
				fired: false,
				reason: ownerLaunchLine({
					failure: { kind: "cli", refusal: { cause: "needs_pick", available: ["claude", "opencode"] } },
				}),
			});
			expect(missing).toMatchObject({ fired: false, reason: expect.any(String) });
			expect(h.host.creates).toHaveLength(creates);
		});

		it("fires into a container that has not said what it runs, leaving the pick to the launch", async () => {
			containers([{ project: PROJECT, state: "stopped", clis: [] }]);
			const before = h.host.wakes.length;

			const firing = fire({ kind: "new", target: h.target(PROJECT) });
			const wake = await h.waitFor(() => h.host.wakes[before], "the wake");
			const woken = attachFakeSession(h.gateway, {
				team: String(wake.team),
				conversationId: "conv-fired",
				sessionToken: wake.sessionToken as string,
			});
			attached.push(woken);

			expect(await firing).toMatchObject({ fired: true });
			expect(wake.harness).toBe(UNPICKED_WORD);
		});

		it("answers a fire into a new session at launch, and tells the owner by a titled notice when it fails", async () => {
			let team: string | undefined;
			h.host.handlers.failCreateSession = (create) => {
				team = create.team;
				return { error: "the pane died", failure: { kind: "error", reason: "the pane died" } };
			};

			const fired = await fire({ kind: "new", target: h.target("host"), cli: "claude" });
			const notice = await ownerNotice(() => team);

			expect(fired).toMatchObject({ fired: true, status: "starting" });
			expect(notice).toMatchObject({ kind: "notice", title: expect.any(String) });
		});

		const putRoutine = async (id: string, target: Routine["target"], baseRevision?: number) => {
			const routine: Routine = {
				id,
				name: id,
				weekdays: [1],
				weekInterval: 1,
				startDate: "2026-09-07",
				time: "09:00",
				zone: "America/Los_Angeles",
				runbookId: book.id,
				approvedRevision: 1,
				values: {},
				target,
				linkedEntries: [],
				forgetAfterDays: 7,
				enabled: true,
				revision: (baseRevision ?? 0) + 1,
				since: 0,
			};
			const { result } = await h.phone.value({ kind: "routine_put", routine, baseRevision });
			return (result as { revision: number }).revision;
		};
		const runRoutine = async (id: string, target: Routine["target"]) => {
			await putRoutine(id, target);
			await h.phone.value({ kind: "routine_run", routineId: id });
			return `${target.spawn}.${routineSessionName(id)}`;
		};
		const reviewOf = (id: string) =>
			h.waitFor(async () => {
				// Walks read launch ends.
				await h.gateway.faults.sweepRoutines();
				const { result } = await h.phone.value({ kind: "routine_list" });
				const held = (result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
					(row) => row.routine.id === id,
				);
				return held?.reviewReason;
			}, `the review of ${id}`);

		const hostClis = ["claude", "opencode"] as const;
		it.each<[string, string, () => void, Routine["target"], CliRefusal]>([
			[
				"a CLI the host does not run",
				"refused-host",
				() => {},
				{ spawn: "host", cli: "copilot" },
				{ cause: "not_installed", available: [...hostClis], named: "copilot" },
			],
			[
				"two CLIs on the host and none picked",
				"refused-unpicked",
				() => {},
				{ spawn: "host", cli: "unpicked" },
				{ cause: "needs_pick", available: [...hostClis] },
			],
			[
				"a CLI a running container lacks",
				"refused-container",
				() => containers([{ project: PROJECT, state: "running", clis: ["opencode"] }]),
				{ spawn: PROJECT, cli: "claude" },
				{ cause: "not_installed", available: ["opencode"], named: "claude" },
			],
		])("stops a routine run for review without launching, on %s", async (label, id, arrange, target, refusal) => {
			arrange();
			const wakes = h.host.wakes.length;

			await runRoutine(id, target);

			expect(await reviewOf(id), label).toBe(ownerLaunchPhrase({ kind: "cli", refusal }));
			expect(h.host.wakes).toHaveLength(wakes);
		});

		it("keeps the CLI of a routine's own session when the routine is left unpicked, on a host with two", async () => {
			const id = "kept";
			const revision = await putRoutine(id, { spawn: "host", cli: "claude" });
			let own: FakeSession | undefined;
			h.host.handlers.onCreateSession = (create) => {
				if (create.target.sessionName !== routineSessionName(id) || own) return;
				own = attachFakeSession(h.gateway, {
					team: create.team,
					conversationId: "conv-kept",
					sessionToken: create.sessionToken,
				});
				attached.push(own);
			};
			await h.phone.value({ kind: "routine_run", routineId: id });
			await h.waitFor(() => own, "the first reserve's session");
			await own?.ready();
			// Offline, so it relaunches.
			own?.close();

			await putRoutine(id, { spawn: "host", cli: "unpicked" }, revision);
			await h.phone.value({ kind: "routine_run", routineId: id });
			const launches = () => h.host.wakes.filter((frame) => frame.team === own?.team);
			await h.waitFor(() => launches()[1], "the second reserve");
			const { result } = await h.phone.value({ kind: "routine_list" });

			expect(launches().map((frame) => [frame.door, frame.harness])).toEqual([
				["create", "claude"],
				[undefined, "claude"],
			]);
			expect(
				(result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
					(row) => row.routine.id === id,
				)?.reviewReason,
			).toBeUndefined();
		});

		it("reserves a routine's session on a container that has not said what it runs, leaving the pick to the launch", async () => {
			// Stopped container's list untrusted.
			containers([{ project: PROJECT, state: "stopped", clis: [] }]);

			const team = await runRoutine("unpicked", { spawn: PROJECT, cli: "unpicked" });
			const wake = await h.waitFor(() => h.host.wakes.find((frame) => frame.team === team), "the wake");

			expect(wake.harness).toBe(UNPICKED_WORD);
		});

		const noCli: LaunchFailure = { kind: "cli", refusal: { cause: "none_installed" } };

		it("stops a routine run for review when a container's launch finds no CLI, and leaves no blank session behind", async () => {
			containers([{ project: PROJECT, state: "stopped" }]);
			wakeAnswer.value = { failure: noCli };

			const team = await runRoutine("daemon-container", { spawn: PROJECT, cli: "unpicked" });
			const review = await reviewOf("daemon-container");
			const resent = await send(team);

			expect(review).toBe(ownerLaunchPhrase(noCli));
			expect(resent).toMatchObject({ status: 404, json: { refused: { kind: "no_label" } } });
		});

		it("stops a routine run for review when the host's create finds no CLI", async () => {
			h.host.handlers.failCreateSession = () => ({ error: "no CLI", failure: noCli });

			await runRoutine("daemon-host", { spawn: "host", cli: "claude" });

			expect(await reviewOf("daemon-host")).toBe(ownerLaunchPhrase(noCli));
		});
	});
});
