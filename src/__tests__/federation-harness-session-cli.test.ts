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

	beforeAll(async () => {
		h = await startFederationHarness();
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
		const launchedUnder = h.host.ops.find(
			(op) => op.kind === "createSession" && copilot.team.endsWith(`.${op.target.sessionName}`),
		);
		const id = launchedUnder?.kind === "createSession" ? launchedUnder.resumeSessionId : undefined;

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
				harnessSessionId: id,
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

	it("refuses a Copilot session on a devcontainer spawn point, and keeps no record of it", async () => {
		const wakes = h.host.wakes.length;

		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("fixture-app"),
			sessionName: "cop",
			harness: "copilot",
		});

		expect(result).toMatchObject({ kind: "refusal" });
		expect(h.gateway.faults.sessionRecord("fixture-app.cop")).toBeUndefined();
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
});
