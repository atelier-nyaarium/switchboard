import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLI_REFUSED_REASON } from "../gateway/routines/reservation.js";
import { type CliRefusal, cliRefusalText } from "../shared/cli-resolve.js";
import type { HostOp } from "../shared/host-op.js";
import { type LaunchFailure, launchFailureText, type SendRefusal, sendRefusalText } from "../shared/launch-notice.js";
import type { ContainerState } from "../shared/schemasPresence.js";
import { type Routine, routineSessionName } from "../shared/schemasRoutine.js";
import type { Runbook, RunbookFireTarget } from "../shared/schemasRunbook.js";
import { UNPICKED_WORD } from "../shared/session-harness.js";
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
			"none named, and none it may run installed",
			"ghost-unnamed",
			{ displayLabel: "New" },
			{ kind: "cli", refusal: { cause: "none_installed" } },
		],
		[
			"one named, and none it may run installed",
			"ghost-named",
			{ displayLabel: "New", cli: "claude" },
			{ kind: "cli", refusal: { cause: "none_installed" } },
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

	it("leaves a running container's empty CLI list to the launch", async () => {
		containers([{ project: PROJECT, state: "running", clis: [] }]);

		const answer = await send(`${PROJECT}.empty`, { displayLabel: "Empty" });
		const wake = await h.waitFor(
			() => h.host.wakes.find((frame) => answer.json.target === h.target(String(frame.team))),
			"the wake",
		);

		expect(answer.json).toMatchObject({ status: "starting" });
		expect(wake.harness).toBe(UNPICKED_WORD);
	});

	it("refuses a CLI the place never runs, whatever it has installed", async () => {
		containers([{ project: PROJECT, state: "running", clis: ["claude"] }]);
		const wakes = h.host.wakes.length;

		const answer = await send(`${PROJECT}.ghost-placed`, { displayLabel: "New", cli: "copilot" });

		expect(answer.json).toMatchObject({ refused: { kind: "cli", refusal: { cause: "refused" } } });
		expect(h.host.wakes).toHaveLength(wakes);
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
		h.host.sendFrame({ type: "wake_stage", team, stage: "cli_found", harness: "claude" });
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

	it("words a create the daemon found no single CLI for as a create, listing what the spawn point has", async () => {
		const refusal: CliRefusal = { cause: "needs_pick", available: ["claude", "opencode"] };
		let minted = "";
		h.host.handlers.failCreateSession = (op) => {
			minted = op.target.sessionName;
			return { error: "pick one", failure: { kind: "cli", refusal } };
		};

		const created = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Picky",
			harness: "claude",
		});

		expect(created.result).toEqual({ kind: "refusal", reason: cliRefusalText(refusal, minted) });
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

		it("answers a fire whose new session's launch failed with that failure, not a wait to retry", async () => {
			const failure: LaunchFailure = { kind: "error", reason: "the pane died" };
			const before = h.host.ops.length;
			let settled = false;

			const firing = fire({ kind: "new", target: h.target("host"), cli: "claude" }).finally(() => {
				settled = true;
			});
			const op = await h.waitFor(
				() =>
					h.host.ops
						.slice(before)
						.find(
							(held): held is Extract<HostOp, { kind: "createSession" }> => held.kind === "createSession",
						),
				"the create",
			);
			const team = `host.${op.target.sessionName}`;
			while (!settled) {
				h.host.sendFrame({ type: "wake_result", team, success: false, failure });
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			expect(await firing).toEqual({
				fired: false,
				sessionId: op.target.sessionName,
				reason: launchFailureText(failure, op.target.sessionName, { created: true, foreign: false }),
			});
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
		const createsOf = (id: string) =>
			h.host.ops.filter(
				(op) => op.kind === "createSession" && op.target.sessionName === routineSessionName(id),
			) as Array<Extract<HostOp, { kind: "createSession" }>>;
		const reviewOf = (id: string) =>
			h.waitFor(async () => {
				const { result } = await h.phone.value({ kind: "routine_list" });
				const held = (result as { routines: Array<{ routine: Routine; reviewReason?: string }> }).routines.find(
					(row) => row.routine.id === id,
				);
				return held?.reviewReason;
			}, `the review of ${id}`);

		it.each<[string, string, () => void, Routine["target"]]>([
			["a CLI the host does not run", "refused-host", () => {}, { spawn: "host", cli: "copilot" }],
			["two CLIs on the host and none picked", "refused-unpicked", () => {}, { spawn: "host", cli: "unpicked" }],
			[
				"a CLI a running container lacks",
				"refused-container",
				() => containers([{ project: PROJECT, state: "running", clis: ["opencode"] }]),
				{ spawn: PROJECT, cli: "claude" },
			],
		])("stops a routine run for review without launching, on %s", async (label, id, arrange, target) => {
			arrange();
			const wakes = h.host.wakes.length;
			const creates = h.host.ops.filter((op) => op.kind === "createSession").length;

			await runRoutine(id, target);

			expect(await reviewOf(id), label).toBe(CLI_REFUSED_REASON);
			expect(h.host.wakes).toHaveLength(wakes);
			expect(h.host.ops.filter((op) => op.kind === "createSession")).toHaveLength(creates);
		});

		it("keeps the CLI of a routine's own session when the routine is left unpicked, on a host with two", async () => {
			const id = "kept";
			const revision = await putRoutine(id, { spawn: "host", cli: "claude" });
			h.host.handlers.onCreateSession = (op) => {
				if (
					op.target.sessionName !== routineSessionName(id) ||
					attached.some((held) => held.team === `host.${op.target.sessionName}`)
				)
					return;
				attached.push(
					attachFakeSession(h.gateway, {
						team: `host.${op.target.sessionName}`,
						conversationId: "conv-kept",
						sessionToken: op.sessionToken,
					}),
				);
			};
			await h.phone.value({ kind: "routine_run", routineId: id });
			await h.waitFor(() => createsOf(id)[0], "the first reserve");

			await putRoutine(id, { spawn: "host", cli: "unpicked" }, revision);
			await h.phone.value({ kind: "routine_run", routineId: id });
			await h.waitFor(() => createsOf(id)[1], "the second reserve");
			const { result } = await h.phone.value({ kind: "routine_list" });

			expect(createsOf(id).map((op) => op.harness)).toEqual(["claude", "claude"]);
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

			expect(review).toBe(CLI_REFUSED_REASON);
			expect(resent).toMatchObject({ status: 404, json: { refused: { kind: "no_label" } } });
		});

		it("stops a routine run for review when the host's create finds no CLI", async () => {
			h.host.handlers.failCreateSession = () => ({ error: "no CLI", failure: noCli });

			await runRoutine("daemon-host", { spawn: "host", cli: "claude" });

			expect(await reviewOf("daemon-host")).toBe(CLI_REFUSED_REASON);
		});
	});
});
