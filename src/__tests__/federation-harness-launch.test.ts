import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchNoticeText } from "../shared/launch-notice.js";
import { composeSessionName } from "../shared/session-id.js";
import type { RidingAwareness } from "../shared/types.js";
import type { FakeAmbient } from "../testing/fakeAmbient.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import type { Frame } from "../testing/fakeSocket.js";
import { type DomainPeer, type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

interface Asleep {
	team: string;
	token?: string;
}

/** Launch notices a session got for that address. */
const noticesIn = (session: FakeSession, address: string) =>
	session.inbound.flatMap((frame) => {
		const awareness = frame.awareness as RidingAwareness | undefined;
		return awareness?.body.includes(`session: ${address}`) ? [awareness] : [];
	});

const messagesIn = (session: FakeSession, body: string) =>
	session.inbound.filter((frame) => frame.type === "channel_push" && frame.body === body);

/** Signed proofs need the clocks in step. */
async function advanceAll(clocks: FakeAmbient[], ms: number): Promise<void> {
	for (const clock of clocks) await clock.advance(ms);
}

describe("a session's send to a session that is not up", () => {
	let h: FederationHarness;
	let sender: FakeSession;
	const tokens = new Map<string, string | undefined>();
	const attached: FakeSession[] = [];
	const daemon: { answer: "launched" | "failed" } = { answer: "launched" };
	let made = 0;

	const attach = (team: string, token: string | undefined): FakeSession => {
		made += 1;
		const session = attachFakeSession(h.gateway, {
			team,
			conversationId: `conv-launch-${made}`,
			sessionToken: token,
			agentPid: 100,
			subId: `launch-${made}`,
		});
		attached.push(session);
		return session;
	};

	const create = async (sessionName: string): Promise<FakeSession> => {
		const { result } = await h.phone.value({ kind: "create_session", target: h.target("host"), sessionName });
		expect(result).toMatchObject({ created: true });
		const team = composeSessionName("host", sessionName);
		await h.waitFor(() => tokens.has(team), `the launch of ${team}`);
		const session = attach(team, tokens.get(team));
		await session.ready();
		return session;
	};

	/** A session with a record, its plugin gone. */
	const asleep = async (sessionName: string): Promise<Asleep> => {
		const session = await create(sessionName);
		session.close();
		return { team: session.team, token: session.sessionToken };
	};

	const send = async (to: string, body: string, extra: Record<string, unknown> = {}) =>
		(await (
			await sender.post("/send", {
				from: sender.team,
				fromConversationId: sender.conversationId,
				to,
				body,
				...extra,
			})
		).json()) as Record<string, unknown>;

	const noticesFor = (address: string) => noticesIn(sender, address);
	const messages = messagesIn;

	const step = (ms: number) => advanceAll([h.ambient, h.routerAmbient], ms);
	/** Moves the clocks a second at a time until `probe` answers. */
	const pump = async <T>(probe: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
		for (let second = 0; second < 90; second += 1) {
			const found = await probe();
			if (found !== undefined) return found;
			await step(1000);
		}
		throw new Error(`never saw ${label}`);
	};
	const passes = async (seconds: number) => {
		for (let second = 0; second < seconds; second += 1) await step(1000);
	};
	/** Lets the Gateway's own timers run while `work` waits on them; answers the time it took. */
	const whileTimePasses = async (work: Promise<unknown>): Promise<number> => {
		let done = false;
		let elapsed = 0;
		const settled = work.finally(() => {
			done = true;
		});
		while (!done) {
			await step(100);
			elapsed += 100;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await settled;
		return elapsed;
	};

	beforeAll(async () => {
		h = await startFederationHarness({
			drive: "manual",
			host: {
				onCreateSession: (op) =>
					tokens.set(composeSessionName(op.target.name, op.target.sessionName), op.sessionToken),
				answerWake: () => daemon.answer,
			},
		});
		sender = await create("sender");
	}, 30_000);
	afterAll(async () => {
		for (const session of attached) session.close();
		if (h) await h.close();
	});

	it("answers that the session is starting, then delivers once it is up and tells the sender", async () => {
		const sleeper = await asleep("sleeper");
		const address = h.target(sleeper.team);

		const answer = await send(sleeper.team, "wake up");
		const woken = attach(sleeper.team, sleeper.token);
		await h.waitFor(() => messages(woken, "wake up")[0], "the queued message");
		const notice = await pump(() => noticesFor(address)[0], "the started notice");

		expect(answer).toMatchObject({ status: "starting", target: address });
		expect(answer.message).toBe(
			`Starting \`${address}\`. Message will auto-send afterwards. You will be notified by a system reminder when it completes or fails.`,
		);
		expect(notice).toMatchObject({ act: "no_act" });
		expect(notice.body).toContain(launchNoticeText({ kind: "up", address }));
	});

	it("answers a create with the address it minted, and delivers there once it is up", async () => {
		const answer = await send("fixture-app.newbie", "hello newbie", { displayLabel: "Newbie" });
		const wake = (await h.waitFor(
			() => h.host.wakes.find((frame) => answer.target === h.target(String(frame.team))),
			"the wake of the minted session",
		)) as Frame;
		const address = h.target(String(wake.team));
		const woken = attach(String(wake.team), wake.sessionToken as string);
		await h.waitFor(() => messages(woken, "hello newbie")[0], "the queued message");
		const notice = await pump(() => noticesFor(address)[0], "the started notice");

		expect(answer).toMatchObject({ status: "starting", target: address });
		expect(notice.body).toContain(launchNoticeText({ kind: "up", address }));
	});

	it("tells the sender to act when the daemon fails the wake, delivers nothing later, and forgets a create", async () => {
		const sleeper = await asleep("unlucky");
		daemon.answer = "failed";
		try {
			const woke = await send(sleeper.team, "never seen");
			const created = await send("fixture-app.doomed", "never seen either", { displayLabel: "Doomed" });
			const doomed = String(created.target).split(".").slice(2).join(".");
			const notices = await pump(() => {
				const both = [noticesFor(String(woke.target))[0], noticesFor(String(created.target))[0]];
				return both.every(Boolean) ? both : undefined;
			}, "both failure notices");
			daemon.answer = "launched";
			const late = attach(sleeper.team, sleeper.token);
			expect(await late.registered()).toMatchObject({ type: "register_ok" });
			await passes(5);

			expect([woke.status, created.status]).toEqual(["starting", "starting"]);
			for (const notice of notices) {
				expect(notice).toMatchObject({ act: "act_now" });
				expect(notice?.body).toContain("Send again to retry.");
				// Not the timeout.
				expect(notice?.body).not.toContain("within 10 minutes");
			}
			expect(messages(late, "never seen")).toEqual([]);
			expect(h.gateway.faults.sessionRecord(doomed)).toBeUndefined();
		} finally {
			daemon.answer = "launched";
		}
	});

	it("tells the sender a session that never comes up did not, and leaves nothing queued for it", async () => {
		const sleeper = await asleep("never");
		const address = h.target(sleeper.team);

		const answer = await send(sleeper.team, "lost in the timeout");
		const notice = await pump(() => noticesFor(address)[0], "the timeout notice");
		const late = attach(sleeper.team, sleeper.token);
		expect(await late.registered()).toMatchObject({ type: "register_ok" });
		await passes(5);

		expect(answer).toMatchObject({ status: "starting", target: address });
		expect(notice).toMatchObject({ act: "act_now" });
		expect(notice.body).toContain(
			launchNoticeText({ kind: "failed", address, failure: { kind: "timeout" }, created: false, foreign: false }),
		);
		expect(messages(late, "lost in the timeout")).toEqual([]);
	});

	it("still makes the phone's send wait for the session, and answers once it is up", async () => {
		const sleeper = await asleep("phoned");
		const opId = "op-launch-phone";
		const result = async () =>
			(await h.phone.inboxRead()).find(
				(row) => row.envelope.kind === "op_result" && row.envelope.opKey.opId === opId,
			);

		const accepted = await h.phone.deliver(
			sleeper.team,
			{ kind: "send", to: sleeper.team, body: "from the owner" },
			opId,
		);
		await h.waitFor(() => h.host.wakes.find((frame) => frame.team === sleeper.team), "the wake");
		await passes(3);
		const beforeUp = await result();
		const woken = attach(sleeper.team, sleeper.token);
		const answered = h.phone.open(await pump(result, "the phone's answer")) as {
			ok: boolean;
			result?: Record<string, unknown>;
		};

		expect(accepted.outcome).toBe("accepted");
		expect(beforeUp).toBeUndefined();
		expect(answered.ok).toBe(true);
		expect(answered.result?.status).not.toBe("starting");
		expect(messages(woken, "from the owner")).toHaveLength(1);
	});

	it("delivers both of two sends to one launching session, and tells the sender once", async () => {
		const sleeper = await asleep("twice");
		const address = h.target(sleeper.team);

		const first = await send(sleeper.team, "first of two");
		const second = await send(sleeper.team, "second of two");
		const woken = attach(sleeper.team, sleeper.token);
		await h.waitFor(() => messages(woken, "second of two")[0], "the second message");
		await pump(() => noticesFor(address)[0], "the started notice");
		await passes(65);

		expect([first.status, second.status]).toEqual(["starting", "starting"]);
		expect(messages(woken, "first of two")).toHaveLength(1);
		expect(noticesFor(address)).toHaveLength(1);
	});

	it("still tells the sender once the session comes up after a Gateway restart mid-launch", async () => {
		const sleeper = await asleep("restarted");
		const address = h.target(sleeper.team);
		const answer = await send(sleeper.team, "across the restart");

		const restarted = await whileTimePasses(h.restartGateway());
		sender = attach(sender.team, sender.sessionToken);
		await sender.ready();
		const woken = attach(sleeper.team, sleeper.token);
		await h.waitFor(() => messages(woken, "across the restart")[0], "the queued message");
		const notice = await pump(() => noticesFor(address)[0], "the started notice");

		expect(restarted).toBeLessThan(10_000);
		expect(answer).toMatchObject({ status: "starting", target: address });
		expect(notice.body).toContain(launchNoticeText({ kind: "up", address }));
	});
});

describe("a session's send to another Domain's session that is not up", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	let asker: FakeSession;
	const attached: FakeSession[] = [];
	const daemon: { answer: "launched" | "failed" } = { answer: "launched" };
	let made = 0;

	const attach = (peer: DomainPeer, team: string): FakeSession => {
		made += 1;
		const session = attachFakeSession(peer.gateway, {
			team,
			conversationId: `conv-far-${made}`,
			subId: `far-${made}`,
		});
		attached.push(session);
		return session;
	};
	/** Shared to this Domain, its plugin gone. */
	const asleepOnBob = async (team: string): Promise<string> => {
		const session = attach(bob, team);
		await session.ready();
		const sessionTarget = bob.target(team);
		await h.waitFor(async () => {
			const answer = (await bob.phone.send({
				kind: "cross_domain_share",
				sessionTarget,
				target: { kind: "domain", domainId: h.set.domain.id },
			})) as { ok?: boolean; reason?: string };
			return answer.ok === true || undefined;
		}, `the share of ${team}`);
		await h.waitFor(
			() => bob.gateway.faults.sharesHeld().sessionTargets.includes(sessionTarget) || undefined,
			"the Gateway's copy of the share",
		);
		session.close();
		return sessionTarget;
	};
	const send = async (to: string, body: string) =>
		asker.post("/send", {
			from: asker.team,
			fromConversationId: asker.conversationId,
			to,
			targetDomainId: bob.set.domain.id,
			body,
		});
	/** Both Gateways' clocks, a second at a time. */
	const pump = async <T>(probe: () => T | undefined, label: string): Promise<T> => {
		for (let second = 0; second < 90; second += 1) {
			const found = probe();
			if (found !== undefined) return found;
			await advanceAll([h.ambient, bob.ambient, h.routerAmbient], 1000);
		}
		throw new Error(`never saw ${label}`);
	};

	beforeAll(async () => {
		h = await startFederationHarness({ drive: "manual" });
		bob = await h.addDomain({ domainId: "bob", gatewayId: "desk", host: { answerWake: () => daemon.answer } });
		await h.link(h, bob);
		asker = attach(h, "fixture-app.asker");
		await asker.ready();
	}, 60_000);
	afterAll(async () => {
		for (const session of attached) session.close();
		if (h) await h.close();
	});

	it("queues a relayed send behind the far launch, and tells the sender once it is up", async () => {
		const address = await asleepOnBob("fixture-app.far");

		const sent = await send(address, "across Domains");
		const woken = attach(bob, "fixture-app.far");
		await h.waitFor(() => messagesIn(woken, "across Domains")[0], "the queued message");
		const notice = await pump(() => noticesIn(asker, address)[0], "the started notice");

		expect(sent.status).toBe(200);
		expect(notice.body).toContain(launchNoticeText({ kind: "up", address }));
	});

	it("tells the sender to act when the far daemon fails the wake, and the far session gets nothing later", async () => {
		const address = await asleepOnBob("fixture-app.farfail");
		daemon.answer = "failed";
		try {
			const sent = await send(address, "never across");
			const notice = await pump(() => noticesIn(asker, address)[0], "the failure notice");
			daemon.answer = "launched";
			const late = attach(bob, "fixture-app.farfail");
			await late.ready();
			for (let second = 0; second < 5; second += 1) {
				await advanceAll([h.ambient, bob.ambient, h.routerAmbient], 1000);
			}

			expect(sent.status).toBe(200);
			expect(notice).toMatchObject({ act: "act_now" });
			expect(notice.body).toContain("Send again to retry.");
			expect(notice.body).not.toContain("within 10 minutes");
			expect(messagesIn(late, "never across")).toEqual([]);
		} finally {
			daemon.answer = "launched";
		}
	});
});
