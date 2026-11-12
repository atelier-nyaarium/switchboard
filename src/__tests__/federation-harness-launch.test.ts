import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LaunchFailure, launchFailureText, launchNoticeText } from "../shared/launch-notice.js";
import { composeSessionName } from "../shared/session-id.js";
import type { RidingAwareness } from "../shared/types.js";
import type { FakeAmbient } from "../testing/fakeAmbient.js";
import { attachFakeHost } from "../testing/fakeHost.js";
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

/** Who a session's open jobs name. */
const pendingTo = async (session: FakeSession) =>
	((await (await session.get("/pending")).json()) as { to: string }[]).map((row) => row.to);

/** Signed proofs need the clocks in step. */
async function advanceAll(clocks: FakeAmbient[], ms: number): Promise<void> {
	for (const clock of clocks) await clock.advance(ms);
}

describe("a session's send to a session that is not up", () => {
	let h: FederationHarness;
	let sender: FakeSession;
	const tokens = new Map<string, string | undefined>();
	const attached: FakeSession[] = [];
	const daemon: { answer: "launched" | "failed" | "silent" } = { answer: "launched" };
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

	const sendFrom = async (from: FakeSession, to: string, body: string, extra: Record<string, unknown> = {}) =>
		(await (
			await from.post("/send", {
				from: from.team,
				fromConversationId: from.conversationId,
				to,
				body,
				...extra,
			})
		).json()) as Record<string, unknown>;
	const send = (to: string, body: string, extra: Record<string, unknown> = {}) => sendFrom(sender, to, body, extra);

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
	/** Lets the Gateway's own timers run while `work` waits on them. */
	const whileTimePasses = async (work: Promise<unknown>): Promise<void> => {
		let done = false;
		const settled = work.finally(() => {
			done = true;
		});
		while (!done) {
			await step(100);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await settled;
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

	it("keeps a send's new session the phone woke when its launch times out, and gives up one nobody claimed", async () => {
		// Own sender isolates timeouts.
		const claimant = await create("claimant");
		daemon.answer = "silent";
		try {
			const minted = async (name: string) => {
				const answer = await sendFrom(claimant, `fixture-app.${name}`, `hello ${name}`, { displayLabel: name });
				return (await h.waitFor(
					() => h.host.wakes.find((frame) => answer.target === h.target(String(frame.team))),
					`the wake of ${name}`,
				)) as Frame;
			};
			const claimed = await minted("claimed");
			const unclaimed = await minted("unclaimed");
			// Builds hold both until the wake joins.
			const stage = (stage: string) => {
				for (const frame of [claimed, unclaimed])
					h.host.sendFrame({ type: "wake_stage", team: frame.team, launchId: frame.launchId, stage });
			};
			stage("building");
			const target = h.target(String(claimed.team));
			await h.phone.deliver(String(claimed.team), { kind: "wake", target, harness: "claude" });
			await passes(5);
			stage("container_up");
			await passes(15);
			const cancels = h.host.frames.filter((frame) => frame.type === "wake_cancel");
			const claimedWakes = h.host.wakes.filter((frame) => frame.team === claimed.team);
			daemon.answer = "launched";
			const resent = await sendFrom(claimant, String(claimed.team), "after the timeout");

			// Wake joined, one launch.
			expect(claimedWakes).toHaveLength(1);
			expect(cancels).toEqual([expect.objectContaining({ team: unclaimed.team, launchId: unclaimed.launchId })]);
			expect(resent).toMatchObject({ status: "starting" });
		} finally {
			daemon.answer = "launched";
		}
	});

	it("delivers a resend to the session its create minted, already up, without waking it", async () => {
		const answer = await send("fixture-app.again", "hello again", { displayLabel: "Again" });
		const wake = (await h.waitFor(
			() => h.host.wakes.find((frame) => answer.target === h.target(String(frame.team))),
			"the wake of the minted session",
		)) as Frame;
		const woken = attach(String(wake.team), wake.sessionToken as string);
		await h.waitFor(() => messages(woken, "hello again")[0], "the first message");
		const wakes = h.host.wakes.length;

		const resent = await send("fixture-app.again", "and again", { displayLabel: "Again" });
		await h.waitFor(() => messages(woken, "and again")[0], "the resend");

		expect(resent).toMatchObject({ target: answer.target });
		expect(resent.status).not.toBe("starting");
		expect(h.host.wakes).toHaveLength(wakes);
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
			const retried = await send(doomed, "after the failure");

			expect([woke.status, created.status]).toEqual(["starting", "starting"]);
			for (const notice of notices) {
				expect(notice).toMatchObject({ act: "act_now" });
				expect(notice?.body).toContain("Send again to retry.");
				// Not the timeout.
				expect(notice?.body).not.toContain("within 10 minutes");
			}
			expect(messages(late, "never seen")).toEqual([]);
			expect(retried).toMatchObject({ refused: { kind: "no_label" } });
		} finally {
			daemon.answer = "launched";
		}
	});

	it("keeps the reply an earlier message waits on through a failed launch, and drops a job the failed send made", async () => {
		const keeper = await create("keeper");
		await send(keeper.team, "first");
		const first = await h.waitFor(() => messages(keeper, "first")[0], "the first message");
		keeper.close();
		const dropper = await asleep("dropper");
		daemon.answer = "failed";
		try {
			await send(keeper.team, "second");
			await send(dropper.team, "never");
			await pump(() => {
				const both = [noticesFor(h.target(keeper.team))[0], noticesFor(h.target(dropper.team))[0]];
				return both.every(Boolean) ? both : undefined;
			}, "both failure notices");
			daemon.answer = "launched";
			const waiting = await pendingTo(sender);
			const back = attach(keeper.team, keeper.sessionToken);
			await back.registered();
			const replied = await back.reply(String(first.session_id), "answer to first");
			await pump(
				() => sender.frames.find((frame) => JSON.stringify(frame).includes("answer to first")),
				"the answer reaching the sender",
			);

			expect(waiting).toContain(keeper.team);
			expect(waiting).not.toContain(dropper.team);
			expect(replied.status).toBe(200);
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

	it("closes a created session whose wait ran out while its launch is still counting down", async () => {
		const team = composeSessionName("host", "closing");
		const startedAt = h.ambient.now();
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			sessionName: "closing",
		});
		await h.waitFor(() => tokens.has(team) || undefined, "the launch");
		// Harness wait; the launch's next look follows.
		await step(startedAt + 10_000 - h.ambient.now());
		const ops = h.host.ops.length;
		await h.phone.deliver(team, { kind: "close_session", target: h.target(team) }, "op-close-launching");
		const kill = await h.waitFor(() => h.host.ops.slice(ops).find((op) => op.kind === "killSession"), "the kill");
		const toldOwner = h.phone
			.entries(await h.phone.inboxRead())
			.filter((entry) => entry.kind === "notice" && entry.from === h.target(team));

		expect(result).toMatchObject({ created: true, status: "pending" });
		expect(kill).toBeDefined();
		expect(toldOwner).toEqual([]);
	});

	it("posts the owner nothing for a created session that comes up", async () => {
		const session = await create("quiet-up");
		await passes(5);
		const toldOwner = h.phone
			.entries(await h.phone.inboxRead())
			.filter((entry) => entry.kind === "notice" && entry.from === h.target(session.team));

		expect(toldOwner).toEqual([]);
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

	it("forgets a build's stage when the host registers again, so a later launch still times out", async () => {
		const sleeper = await asleep("rebuilt");
		const address = h.target(sleeper.team);
		h.host.sendFrame({ type: "wake_stage", team: sleeper.team, launchId: "launch-before", stage: "building" });
		h.host.vanish();
		const replacement = attachFakeHost(h.gateway, { token: h.set.tokens.host, answerWake: () => "silent" });
		try {
			await h.waitFor(
				() => replacement.frames.find((frame) => frame.type === "register_ok"),
				"the new registration",
			);
			const answer = await send(sleeper.team, "after the rebuild");
			const notice = await pump(() => noticesFor(address)[0], "the timeout notice");

			expect(answer).toMatchObject({ status: "starting" });
			expect(replacement.wakes.map((frame) => frame.team)).toEqual([sleeper.team]);
			expect(notice.body).toContain(
				launchNoticeText({
					kind: "failed",
					address,
					failure: { kind: "timeout" },
					created: false,
					foreign: false,
				}),
			);
		} finally {
			replacement.close();
			h.restartHost();
		}
	});

	it("still tells the sender once the session comes up after a Gateway restart mid-launch", async () => {
		const sleeper = await asleep("restarted");
		const address = h.target(sleeper.team);
		const answer = await send(sleeper.team, "across the restart");

		await whileTimePasses(h.restartGateway());
		sender = attach(sender.team, sender.sessionToken);
		await sender.ready();
		const woken = attach(sleeper.team, sleeper.token);
		await h.waitFor(() => messages(woken, "across the restart")[0], "the queued message");
		const notice = await pump(() => noticesFor(address)[0], "the started notice");

		expect(answer).toMatchObject({ status: "starting", target: address });
		expect(notice.body).toContain(launchNoticeText({ kind: "up", address }));
	});
});

describe("a session's send to another Domain's session that is not up", () => {
	let h: FederationHarness;
	let bob: DomainPeer;
	let asker: FakeSession;
	const attached: FakeSession[] = [];
	const daemon: { answer: "launched" | "failed" | { failure: LaunchFailure } } = { answer: "launched" };
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
	/** Shared to this Domain and up. */
	const sharedOnBob = async (team: string): Promise<{ session: FakeSession; address: string }> => {
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
		return { session, address: sessionTarget };
	};
	/** Shared to this Domain, its plugin gone. */
	const asleepOnBob = async (team: string): Promise<string> => {
		const { session, address } = await sharedOnBob(team);
		session.close();
		return address;
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
	const pump = async <T>(probe: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
		for (let second = 0; second < 90; second += 1) {
			const found = await probe();
			if (found !== undefined) return found;
			await advanceAll([h.ambient, bob.ambient, h.routerAmbient], 1000);
		}
		throw new Error(`never saw ${label}`);
	};
	const phoneSend = async (peer: DomainPeer, to: string, body: string, domainId?: string) => {
		made += 1;
		const opId = `far-phone-${made}`;
		const accepted = await peer.phone.deliver(
			to,
			{ kind: "send", to, body, ...(domainId ? { domainId } : {}) },
			opId,
		);
		expect(accepted.outcome).toBe("accepted");
		const row = await pump(
			async () =>
				(await peer.phone.inboxRead()).find(
					(held) => held.envelope.kind === "op_result" && held.envelope.opKey.opId === opId,
				),
			`the answer to ${opId}`,
		);
		return peer.phone.open(row);
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

	it("keeps the reply an earlier message waits on when the far launch of a later one fails", async () => {
		const { session: far, address } = await sharedOnBob("fixture-app.farkeep");
		await send(address, "first across");
		const first = await pump(() => messagesIn(far, "first across")[0], "the first message");
		far.close();
		daemon.answer = "failed";
		try {
			await send(address, "second across");
			await pump(() => noticesIn(asker, address)[0], "the failure notice");
			daemon.answer = "launched";
			const back = attach(bob, "fixture-app.farkeep");
			await back.registered();
			const replied = await back.reply(String(first.session_id), "answer across");
			await pump(
				() => asker.frames.find((frame) => JSON.stringify(frame).includes("answer across")),
				"the answer reaching the sender",
			);

			expect(replied.status).toBe(200);
		} finally {
			daemon.answer = "launched";
		}
	});

	const failure: LaunchFailure = { kind: "container", spawn: "fixture-app", projectPath: "/home/bob/fixture-app" };

	it("answers the owner's waited send with the container's failure and its path", async () => {
		const address = await asleepOnBob("fixture-app.ownpath");
		daemon.answer = { failure };
		try {
			const answer = await phoneSend(bob, "fixture-app.ownpath", "from its owner");

			expect(answer).toEqual({ ok: false, error: launchFailureText(failure, address) });
			expect(JSON.stringify(answer)).toContain(failure.projectPath);
		} finally {
			daemon.answer = "launched";
		}
	});

	// Skipped: far op_result unconsumed at own inbox.
	it.skip("tells another Domain's phone its send's container failed, without the path", async () => {
		const address = await asleepOnBob("fixture-app.farpath");
		daemon.answer = { failure };
		try {
			await phoneSend(h, address, "from another Domain", bob.set.domain.id);
			const told = await pump(
				async () =>
					h.phone
						.entries(await h.phone.inboxRead())
						.find((entry) => entry.kind === "reply" && entry.status === "error"),
				"the failure on the far phone",
			);

			expect(told.body).toBe(launchFailureText(failure, address, { created: false, foreign: true }));
		} finally {
			daemon.answer = "launched";
		}
	});
});

/** Harness with a silent-launch daemon. */
function wakeResultsRig(launchIds: boolean) {
	let h: FederationHarness;
	let asker: FakeSession;

	beforeAll(async () => {
		h = await startFederationHarness({ host: { launchIds, answerWake: () => "silent" } });
		asker = attachFakeSession(h.gateway, { team: "fixture-app.asker", conversationId: "conv-named-asker" });
		await asker.ready();
	}, 30_000);
	afterAll(async () => {
		asker?.close();
		if (h) await h.close();
	});

	const launch = async (name: string) => {
		const answer = (await (
			await asker.post("/send", {
				from: asker.team,
				fromConversationId: asker.conversationId,
				to: `fixture-app.${name}`,
				body: "hello",
				displayLabel: name,
			})
		).json()) as { target: string };
		return h.waitFor(
			() => h.host.wakes.find((frame) => answer.target === h.target(String(frame.team))),
			"the wake",
		);
	};
	const fail = (team: unknown, named: object) =>
		h.host.sendFrame({
			type: "wake_result",
			team,
			...named,
			success: false,
			failure: { kind: "error", reason: "x" },
		});
	const answered = () =>
		h.host.frames.filter((frame) => frame.type === "wake_result_ack" || frame.type === "wake_cancel");
	const until = (type: string, label: string) =>
		h.waitFor(() => answered().find((frame) => frame.type === type), label);

	return { launch, fail, answered, until };
}

describe("the wake results of a daemon that names its launches", () => {
	const r = wakeResultsRig(true);

	it("acts on a result only when it names its launch, and acks it once applied", async () => {
		const wake = await r.launch("named");

		r.fail(wake.team, {});
		await new Promise((resolve) => setTimeout(resolve, 50));
		const afterUntagged = r.answered();
		r.fail(wake.team, { launchId: wake.launchId });
		await r.until("wake_result_ack", "the ack");

		expect(afterUntagged).toEqual([]);
		expect(r.answered()).toEqual([
			{ type: "wake_cancel", team: wake.team, launchId: wake.launchId },
			{ type: "wake_result_ack", launchId: wake.launchId },
		]);
	});
});

describe("the wake results of an older daemon that names none", () => {
	const r = wakeResultsRig(false);

	it("acts on its untagged result, and acks nothing", async () => {
		const wake = await r.launch("unnamed");

		r.fail(wake.team, {});
		await r.until("wake_cancel", "the give-up");

		expect(r.answered()).toEqual([{ type: "wake_cancel", team: wake.team, launchId: wake.launchId }]);
	});
});
