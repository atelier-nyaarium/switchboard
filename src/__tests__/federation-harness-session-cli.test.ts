import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionHarness } from "../shared/session-harness.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("a session's CLI, as the Gateway tells it", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	let claude: FakeSession;
	let copilot: FakeSession;

	const launch = async (harness: SessionHarness): Promise<FakeSession> => {
		const before = sessions.length;
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: harness,
			harness,
		});
		expect(result).toMatchObject({ created: true });
		const launched = await h.waitFor(() => sessions[before], "the daemon's launch");
		expect(await launched.registered()).toMatchObject({ type: "register_ok" });
		return launched;
	};

	const presenceRows = async (): Promise<Array<Record<string, unknown>>> => {
		const { planes } = await h.phone.planesRead({});
		const payload = planes.find((plane) => plane.name === "presence")?.payload as
			| { rows?: Array<Record<string, unknown>> }
			| undefined;
		return payload?.rows ?? [];
	};

	const sessionNameOf = (held: FakeSession): string => held.team.split(".")[1] ?? "";

	beforeAll(async () => {
		h = await startFederationHarness({ host: { hostSpawns: ["windows"] } });
		h.host.handlers.onCreateSession = (op) => {
			sessions.push(
				attachFakeSession(h.gateway, {
					team: composeSessionName(op.target.name, op.target.sessionName),
					conversationId: `conv-cli-${sessions.length}`,
					sessionToken: op.sessionToken,
					agentPid: 100,
				}),
			);
		};
		claude = await launch("claude");
		await claude.ready();
		copilot = await launch("copilot");
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("tells the daemon each watched session's CLI, and a Copilot session's id under both names", async () => {
		const id = h.host.creates.find((create) => create.team === copilot.team)?.resumeSessionId;

		const watched = await h.waitFor(() => {
			const entries = (h.host.frames.filter((frame) => frame.type === "presence_watch").at(-1)?.watch ??
				[]) as Array<Record<string, unknown>>;
			const mine = [claude, copilot].map(({ team }) => entries.find((entry) => entry.team === team));
			return mine.every(Boolean) ? mine : undefined;
		}, "both sessions watched");

		expect(id).toBeTruthy();
		expect(watched).toEqual([
			{ team: claude.team, cadenceMs: expect.any(Number), harness: "claude" },
			{
				team: copilot.team,
				cadenceMs: expect.any(Number),
				harness: "copilot",
				mintedSessionId: id,
				copilotSessionId: id,
			},
		]);
	});

	it("names each session's CLI on its presence row", async () => {
		const named = await h.waitFor(async () => {
			const rows = await presenceRows();
			const mine = [claude, copilot].map(({ team }) => rows.find((row) => row.team === team)?.harness);
			return mine.every(Boolean) ? mine : undefined;
		}, "both presence rows");

		expect(named).toEqual(["claude", "copilot"]);
	});

	it("launches Copilot in a devcontainer, and refuses OpenCode on the Windows shell where Claude launches", async () => {
		const create = (spawn: string, sessionName: string, harness: SessionHarness) =>
			h.phone.value({ kind: "create_session", target: h.target(spawn), sessionName, harness });
		const wakeOf = (team: string) => h.waitFor(() => h.host.wakes.find((frame) => frame.team === team), team);

		const container = await create("fixture-app", "cop", "copilot");
		const containerWake = await wakeOf("fixture-app.cop");
		const windows = await create("windows", "win", "claude");
		const windowsWake = await wakeOf("windows.win");
		const wakes = h.host.wakes.length;
		const refused = await create("windows", "code", "opencode");

		expect(container.result).toMatchObject({ created: true, status: "pending" });
		expect(containerWake).toMatchObject({ door: "create", harness: "copilot" });
		expect(windows.result).toMatchObject({ created: true });
		expect(windowsWake).toMatchObject({ door: "create", harness: "claude" });
		expect(refused.result).toMatchObject({ kind: "refusal" });
		expect(h.gateway.faults.sessionRecord("windows.code")).toBeUndefined();
		expect(h.host.wakes).toHaveLength(wakes);
	});

	it("confirms a launched session whose plugin names a CLI this build does not know, as its record's CLI", async () => {
		const newer = attachFakeSession(h.gateway, {
			team: copilot.team,
			conversationId: "conv-cli-newer",
			sessionToken: copilot.sessionToken,
			agentPid: 100,
			subId: "newer",
			harness: "no-such-cli",
		});
		sessions.push(newer);
		expect(await newer.registered()).toMatchObject({ type: "register_ok" });

		await h.phone.deliver(copilot.team, { kind: "send", to: copilot.team, body: "to the newer plugin" });

		await h.waitFor(() => newer.inbound.find((frame) => frame.body === "to the newer plugin"), "its delivery");
		expect((await newer.post("/session/type", { text: "<channel>typed</channel>" })).status).toBe(200);
		expect(h.gateway.faults.sessionRecord(copilot.team)).toMatchObject({ harness: "copilot" });
	});

	it("reloads plugins on a Claude session, and refuses a Copilot one before the daemon hears of it", async () => {
		const refused = await h.phone.value({ kind: "reload_plugins", target: h.target(copilot.team) });
		const relayed = await h.phone.value({ kind: "reload_plugins", target: h.target(claude.team) });

		expect(refused.result).toMatchObject({ kind: "refusal" });
		expect(relayed.result).toMatchObject({ initiated: true });
		expect(h.host.ops.flatMap((op) => (op.kind === "reloadPlugins" ? [op.target.sessionName] : []))).toEqual([
			sessionNameOf(claude),
		]);
	});

	it("marks a launch fresh until its session first confirms, and opens Create's door only for a new record", async () => {
		try {
			for (const harness of ["claude", "copilot"] as const) {
				const sessionName = `late-${harness}`;
				const create = () =>
					h.phone.value({ kind: "create_session", target: h.target("host"), sessionName, harness });
				let team = "";
				const launches = () =>
					h.host.wakes.filter((frame) => frame.team === team).map((frame) => [frame.door, frame.fresh]);

				h.host.handlers.failCreateSession = () => "the pane never came up";
				expect((await create()).result).toMatchObject({ created: true, status: "pending" });
				team = (
					await h.waitFor(
						() => h.host.creates.find((made) => made.target.sessionName === sessionName),
						"the failed launch",
					)
				).team;
				h.host.handlers.failCreateSession = undefined;

				const before = sessions.length;
				h.host.handlers.onWake = (frame) => {
					if (frame.team !== team) return;
					sessions.push(
						attachFakeSession(h.gateway, {
							team,
							conversationId: `conv-cli-${sessions.length}`,
							sessionToken: frame.sessionToken as string,
							agentPid: 100,
						}),
					);
				};
				expect((await create()).result).toMatchObject({ created: true });
				const retried = await h.waitFor(() => sessions[before], "the retried launch");
				await (harness === "claude" ? retried.ready() : retried.registered());

				// Live needs no launch.
				retried.close();
				h.host.handlers.onWake = undefined;
				await create();
				await h.waitFor(() => launches().length === 3 || undefined, "a launch after the confirm");

				expect(launches(), harness).toEqual([
					["create", true],
					[undefined, true],
					[undefined, undefined],
				]);
			}
		} finally {
			h.host.handlers.failCreateSession = undefined;
			h.host.handlers.onWake = undefined;
		}
	});
});
