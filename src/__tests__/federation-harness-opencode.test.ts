import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderChannelTag } from "../mcp/channel/channelNotify.js";
import { type ApiSession, createOpencodeSession } from "../mcp/opencode/session.js";
import { opencodeAuth } from "../shared/opencode.js";
import {
	parseSessionControlOp,
	SESSION_CONTROL_FRAME,
	SESSION_CONTROL_REPLY_FRAME,
	SESSION_PRESENCE_FRAME,
} from "../shared/session-control.js";
import { HARNESS, type SessionHarness } from "../shared/session-harness.js";
import { composeSessionName } from "../shared/session-id.js";
import type { ChannelPushPayload } from "../shared/types.js";
import { createFakeOpencodeServer, type FakeOpencodeServer } from "../testing/fakeOpencodeServer.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import type { Frame } from "../testing/fakeSocket.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

const ENV_READ = { id: "per_1", action: "read", resources: ["/p/.env"] };

describe("an OpenCode session, driven by its plugin over its own server", () => {
	let h: FederationHarness;
	const attached: FakeSession[] = [];
	const plugins: ApiSession[] = [];
	const launched = new Map<string, { sessionToken?: string; minted?: string }>();
	let server: FakeOpencodeServer;
	let oc: FakeSession;
	let raw: FakeSession;
	let claude: FakeSession;

	const attach = (team: string, harness: SessionHarness, subId?: string): FakeSession => {
		const session = attachFakeSession(h.gateway, {
			team,
			conversationId: `conv-${team.replace(/\W/g, "-")}-${attached.length}`,
			sessionToken: launched.get(team)?.sessionToken,
			agentPid: 100,
			harness,
			...(subId ? { subId } : {}),
		});
		attached.push(session);
		return session;
	};

	const create = async (harness: SessionHarness, sessionName: string): Promise<FakeSession> => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			sessionName,
			harness,
		});
		expect(result).toMatchObject({ created: true });
		const team = composeSessionName("host", sessionName);
		await h.waitFor(() => launched.get(team), `the launch of ${team}`);
		const session = attach(team, harness);
		expect(await session.registered()).toMatchObject({ type: "register_ok" });
		return session;
	};

	/** The plugin's frame glue. */
	const drive = (session: FakeSession, minted: string): ApiSession => {
		const plugin = createOpencodeSession({
			file: { url: server.url, password: server.password, sessionId: minted, directory: "/p" },
			fetch: server.fetch,
			render: renderChannelTag,
			report: (derived) => session.send({ type: SESSION_PRESENCE_FRAME, ...derived }),
			newId: () => crypto.randomUUID(),
			sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
			log: () => undefined,
		});
		session.onFrame((frame: Frame) => {
			if (frame.type === "channel_push" && !frame.replyJsonSchema) {
				void plugin.deliver(frame as unknown as ChannelPushPayload);
			}
			const op = frame.type === SESSION_CONTROL_FRAME ? parseSessionControlOp(frame.op) : null;
			if (op) {
				void plugin.control(op).then((result) => {
					session.send({ type: SESSION_CONTROL_REPLY_FRAME, reqId: frame.reqId, result });
				});
			}
		});
		plugins.push(plugin);
		plugin.start();
		return plugin;
	};

	const rowOf = async (team: string): Promise<Record<string, unknown> | undefined> => {
		const { planes } = await h.phone.planesRead({});
		const payload = planes.find((plane) => plane.name === "presence")?.payload as
			| { rows?: Array<Record<string, unknown>> }
			| undefined;
		return payload?.rows?.find((row) => row.team === team);
	};

	const settles = (team: string, probe: (row: Record<string, unknown>) => boolean, label: string) =>
		h.waitFor(async () => {
			const row = await rowOf(team);
			return row && probe(row) ? row : undefined;
		}, label);

	/** The server's own running list. */
	const activeOf = async (fake: FakeOpencodeServer): Promise<unknown> => {
		const response = await fake.fetch(`${fake.url}/api/session/active`, {
			headers: { authorization: opencodeAuth(fake.password) },
		});
		return ((await response.json()) as { data?: unknown }).data;
	};

	let dispatched = 0;
	/** Bound op and its result. */
	const dispatch = async (team: string, op: Parameters<typeof h.phone.deliver>[1]) => {
		const opId = `op-opencode-${++dispatched}`;
		expect((await h.phone.deliver(team, op, opId)).outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`the result of ${opId}`,
		);
		return h.phone.open(row) as { ok: boolean; result?: Record<string, unknown> };
	};

	beforeAll(async () => {
		h = await startFederationHarness();
		server = createFakeOpencodeServer();
		h.host.handlers.onCreateSession = (op) => {
			const team = composeSessionName(op.target.name, op.target.sessionName);
			launched.set(team, { sessionToken: op.sessionToken, minted: op.resumeSessionId });
			if (op.harness === "opencode" && op.resumeSessionId) server.addSession(op.resumeSessionId, "/p");
		};
		claude = await create("claude", "cc");
		await claude.ready();
	}, 30_000);
	afterAll(async () => {
		for (const plugin of plugins) plugin.stop();
		for (const session of attached) session.close();
		if (h) await h.close();
	});

	it("launches under a minted id and confirms its plugin by its token, with no handshake", async () => {
		oc = await create("opencode", "oc");
		const minted = launched.get(oc.team)?.minted ?? "";

		expect(HARNESS.opencode.sessionId.shape.test(minted)).toBe(true);
		expect(oc.frames.filter((frame) => frame.type === "channel_push")).toEqual([]);
		expect(await settles(oc.team, (row) => row.status === "online", "the session online")).toMatchObject({
			harness: "opencode",
		});
	});

	it("carries its state, a sent message and a permission answer through the plugin and back", async () => {
		const minted = launched.get(oc.team)?.minted ?? "";
		drive(oc, minted);
		await settles(oc.team, (row) => row.working === false, "the first report");

		await h.phone.deliver(oc.team, { kind: "send", to: oc.team, body: "please read the env file" });
		await settles(oc.team, (row) => row.working === true, "the turn it started");
		server.ask({ ...ENV_READ, sessionID: minted });
		await settles(oc.team, (row) => row.promptId === "per_1", "the prompt");
		const answer = await h.phone.value({
			kind: "session_prompt_answer",
			target: h.target(oc.team),
			promptId: "per_1",
			decision: "deny",
			reason: "use .env.example",
		});
		await settles(oc.team, (row) => row.promptId === undefined, "the prompt answered");

		expect(server.messages(minted)).toEqual([
			expect.objectContaining({ type: "user", text: expect.stringContaining("please read the env file") }),
		]);
		expect(answer.result).toEqual({ outcome: "answered" });
		expect(server.replies).toEqual([
			{ id: "per_1", sessionID: minted, decision: "reject", message: "use .env.example" },
		]);
		expect(h.host.ops.some((op) => op.kind === "answerPrompt")).toBe(false);
	});

	it("hands it a baseline once its compaction ends, as context with no turn", async () => {
		const minted = launched.get(oc.team)?.minted ?? "";
		const held = await oc.post("/task-board", {
			from: oc.team,
			action: "create",
			operationId: "opencode-baseline",
			assignTo: "self",
			title: "Held through compaction",
		});
		expect(held.status).toBe(200);
		server.finishTurn(minted);
		await settles(oc.team, (row) => row.working === false, "the turn ended");

		server.startCompaction(minted);
		await settles(oc.team, (row) => row.compacting === true, "the compaction");
		server.finishCompaction(minted);

		const baseline = await h.waitFor(
			() => server.messages(minted).find((row) => row.type === "synthetic"),
			"the baseline posted",
		);
		const active = await activeOf(server);
		await settles(oc.team, (row) => row.compacting === undefined && row.working === false, "the session settled");

		expect(baseline.text).toContain("Held through compaction");
		expect(active).not.toHaveProperty(minted);
		expect(server.messages(minted).filter((row) => row.type === "synthetic")).toHaveLength(1);
	});

	describe("the Gateway's ingress for a plugin-read session", () => {
		const report = (session: FakeSession, fields: Record<string, unknown>) =>
			session.send({ type: SESSION_PRESENCE_FRAME, ...fields });
		const busy = { working: true, needsLogin: false, limitBlocked: false };

		beforeAll(async () => {
			raw = await create("opencode", "raw");
		});

		it("takes a report under the socket's team, only from a confirmed plugin-read session", async () => {
			const squatter = attachFakeSession(h.gateway, {
				team: raw.team,
				conversationId: "conv-squatter",
				harness: "opencode",
				subId: "squatter",
			});
			expect(await squatter.registered()).toMatchObject({ type: "register_reject" });

			report(squatter, { ...busy, prompt: { id: "per_0", title: "Read", body: [] } });
			report(raw, { ...busy, team: claude.team, prompt: { id: "per_9", title: "Read", body: [] } });
			report(claude, busy);
			await settles(raw.team, (row) => row.promptId === "per_9", "the report");
			const pane = await rowOf(claude.team);
			report(squatter, { ...busy, prompt: { id: "per_0", title: "Read", body: [] } });
			h.host.reportWorking(claude.team, true);
			await settles(claude.team, (row) => row.working === true, "a later report");
			squatter.close();

			expect(pane?.working).toBeUndefined();
			expect(pane?.promptId).toBeUndefined();
			expect((await rowOf(raw.team))?.promptId).toBe("per_9");
		});

		it("clears a report on a bare frame, and when the session's last socket closes", async () => {
			report(raw, busy);
			await settles(raw.team, (row) => row.working === true, "the report");

			report(raw, {});
			await settles(raw.team, (row) => row.working === undefined, "the bare frame's clear");
			report(raw, busy);
			await settles(raw.team, (row) => row.working === true, "the report again");
			raw.close();
			await settles(raw.team, (row) => row.working === undefined && row.status !== "online", "the close's clear");

			raw = attach(raw.team, "opencode", "reloaded");
			expect(await raw.registered()).toMatchObject({ type: "register_ok" });
		});

		const baselinesOf = (session: FakeSession) =>
			session.frames.filter(
				(frame) =>
					frame.type === "channel_push" &&
					JSON.stringify(frame.awareness ?? {}).includes("baseline: compaction"),
			);
		/** Gives its baseline something to say. */
		const holdEntry = async (session: FakeSession) => {
			const held = await session.post("/task-board", {
				from: session.team,
				action: "create",
				operationId: `held-${session.team}`,
				assignTo: "self",
				title: `Held by ${session.team}`,
			});
			expect(held.status).toBe(200);
		};

		it("reads a clear mid-compaction as unknown, so only a compaction seen end to end owes a baseline", async () => {
			await holdEntry(raw);

			report(raw, { ...busy, compacting: true });
			report(raw, {});
			report(raw, busy);
			report(raw, { ...busy, compacting: true });
			report(raw, busy);

			await h.waitFor(() => baselinesOf(raw)[0], "the baseline");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(baselinesOf(raw)).toHaveLength(1);
		});

		it("keeps a Copilot compaction across a bare daemon clear, so its end still owes a baseline", async () => {
			const copilot = await create("copilot", "cop");
			await holdEntry(copilot);

			h.host.reportWorking(copilot.team, true, true);
			h.host.reportWorking(copilot.team, null);
			h.host.reportWorking(copilot.team, false, false);

			await h.waitFor(() => baselinesOf(copilot)[0], "the Copilot baseline");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(baselinesOf(copilot)).toHaveLength(1);
		});

		it("sends a prompt answer to the plugin keyed by the console's op, and a Claude one to the daemon", async () => {
			report(raw, { ...busy, prompt: { id: "per_2", title: "Read", body: [] } });
			await settles(raw.team, (row) => row.promptId === "per_2", "the report");
			raw.onFrame((frame) => {
				if (frame.type !== SESSION_CONTROL_FRAME) return;
				raw.send({
					type: SESSION_CONTROL_REPLY_FRAME,
					reqId: frame.reqId,
					result: { ok: true, outcome: "stale" },
				});
			});

			const answer = (session: FakeSession, promptId: string, opId: string) =>
				h.phone.value(
					{ kind: "session_prompt_answer", target: h.target(session.team), promptId, decision: "approve" },
					opId,
				);

			const toPlugin = await answer(raw, "per_2", "op-answer-raw");
			await answer(raw, "per_2", "op-answer-raw-again");
			await answer(claude, "p1", "op-answer-claude");
			const asked = raw.frames.filter((frame) => frame.type === SESSION_CONTROL_FRAME);
			const keys = asked.map((frame) => String(frame.key));

			expect(toPlugin.result).toEqual({ outcome: "stale" });
			expect(asked.map((frame) => frame.op)).toEqual([
				{ kind: "answerPrompt", promptId: "per_2", decision: "approve" },
				{ kind: "answerPrompt", promptId: "per_2", decision: "approve" },
			]);
			expect(keys[0]).toContain("op-answer-raw");
			expect(keys[1]).toContain("op-answer-raw-again");
			expect(keys[0]).not.toBe(keys[1]);
			expect(h.host.ops.filter((op) => op.kind === "answerPrompt")).toEqual([
				expect.objectContaining({ promptId: "p1", dedupKey: expect.stringContaining("op-answer-claude") }),
			]);
		});

		it("refuses the key that exits OpenCode, and typed delivery, before the daemon hears of either", async () => {
			const keys = h.host.ops.length;
			const press = (session: FakeSession, key: string) =>
				dispatch(session.team, { kind: "tmux_send", target: h.target(session.team), key });

			const exit = await press(raw, "C-c");
			const typed = await raw.post("/session/type", { text: "<channel>x</channel>" });
			const esc = await press(raw, "Escape");
			const claudeExit = await press(claude, "C-c");

			expect(exit.ok).toBe(false);
			expect(typed.status).toBe(403);
			expect([esc.result, claudeExit.result]).toEqual([{ sent: true }, { sent: true }]);
			expect(h.host.ops.slice(keys).map((op) => (op.kind === "sendKey" ? op.key : op.kind))).toEqual([
				"Escape",
				"C-c",
			]);
		});

		it("keeps a plugin's report across a host daemon disconnect, and drops a pane session's", async () => {
			report(raw, busy);
			h.host.reportWorking(claude.team, true);
			await settles(raw.team, (row) => row.working === true, "the plugin's report");
			await settles(claude.team, (row) => row.working === true, "the daemon's report");

			h.restartHost();

			await settles(claude.team, (row) => row.working === undefined, "the daemon's report dropped");
			expect((await rowOf(raw.team))?.working).toBe(true);
		});
	});
});
