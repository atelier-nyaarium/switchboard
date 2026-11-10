import { describe, expect, it } from "vitest";
import {
	applyOpencodeEvent,
	compactionsOf,
	derivedFromView,
	EMPTY_VIEW,
	type OpencodeEvent,
	type OpencodeView,
	parseOpencodeVersion,
	promptIdOf,
	viewFromSnapshot,
} from "../shared/opencode.js";

const SESSION = "ses_sbmain";

const started = { type: "session.execution.started", data: { sessionID: SESSION } };
const step = { type: "session.step.started", data: { sessionID: SESSION } };
const succeeded = { type: "session.execution.succeeded", data: { sessionID: SESSION } };
const failed = (type: string, message = "") => ({
	type: "session.execution.failed",
	data: { sessionID: SESSION, error: { type, message } },
});
const compaction = (phase: "started" | "ended" | "failed", inputID: string) => ({
	type: `session.compaction.${phase}`,
	data: { sessionID: SESSION, reason: "auto", inputID },
});

/** Report after each event. */
function reports(events: OpencodeEvent[], from: OpencodeView = EMPTY_VIEW) {
	let view = from;
	return events.map((event) => {
		view = applyOpencodeEvent(view, event, SESSION);
		return derivedFromView(view);
	});
}

const idle = { working: false, needsLogin: false, limitBlocked: false };

describe("a session's state, followed live", () => {
	it("reads a turn as working from its first step until its execution ends", () => {
		expect(reports([started, step, succeeded])).toEqual([idle, { ...idle, working: true }, idle]);
	});

	it("never reads a repeated prompt's empty execution as a turn, and keeps a held limit through it", () => {
		const limited = reports([started, step, failed("provider.free-limit", "resets 5pm")]).at(-1);

		const repeat = reports([started, step, failed("provider.free-limit", "resets 5pm"), started, succeeded]);

		expect(limited).toEqual({ ...idle, limitBlocked: true, limitDetail: "resets 5pm" });
		expect(repeat.slice(3)).toEqual([limited, limited]);
		expect(reports([started, succeeded]).every((derived) => !derived.working)).toBe(true);
	});

	it("reads a limit and a sign-in failure apart, and clears either when the next turn steps", () => {
		const limit = reports([started, step, failed("provider.rate-limit"), started, step]);
		const login = reports([started, step, failed("provider.auth", "token expired"), started, step]);

		expect([limit[2], limit[4]]).toEqual([
			{ ...idle, limitBlocked: true },
			{ ...idle, working: true },
		]);
		expect([login[2], login[4]]).toEqual([
			{ ...idle, needsLogin: true },
			{ ...idle, working: true },
		]);
	});

	it("holds a subagent's permission until its reply", () => {
		const asked = {
			type: "permission.asked",
			data: { id: "per_1", sessionID: "ses_child", action: "read", resources: ["/p/.env"] },
		};
		const replied = {
			type: "permission.replied",
			data: { sessionID: "ses_child", requestID: "per_1", reply: "once" },
		};

		const [waiting, answered] = reports([asked, replied]);

		expect(waiting?.prompt).toMatchObject({ id: "per_1", body: ["/p/.env"] });
		expect(answered).toEqual(idle);
	});

	it("reads a compaction from its start to its end, failed or not", () => {
		const ended = reports([compaction("started", "msg_c1"), compaction("ended", "msg_c1")]);
		const failed = reports([compaction("started", "msg_c2"), compaction("failed", "msg_c2")]);

		expect([ended, failed].map((run) => run.map((derived) => derived.compacting))).toEqual([
			[true, undefined],
			[true, undefined],
		]);
	});

	it("ends a compaction whose end never came when its execution ends", () => {
		expect(reports([started, compaction("started", "msg_c1"), succeeded]).map((d) => d.compacting)).toEqual([
			undefined,
			true,
			undefined,
		]);
	});

	it("ignores another session's turn", () => {
		const other = { type: "session.step.started", data: { sessionID: "ses_other" } };

		expect(reports([other])).toEqual([idle]);
	});
});

describe("a session's state, rebuilt from three reads", () => {
	const turn = (error: { type: string; message: string }) => [
		{ id: "msg_i1", type: "idle", error },
		{ id: "msg_a1", type: "model-switched" },
		{ id: "msg_a2", type: "assistant" },
		{ id: "msg_u1", type: "user" },
	];
	const resting = (rows: Array<{ id: string; type: string }>) =>
		derivedFromView(viewFromSnapshot({ running: false, permissions: [], rows }));

	it("carries a failed turn's sign-in error only while nothing runs", () => {
		const rows = turn({ type: "provider.auth", message: "" });

		const running = derivedFromView(viewFromSnapshot({ running: true, permissions: [], rows }));

		expect(resting(rows)).toEqual({ ...idle, needsLogin: true });
		expect(running).toEqual({ ...idle, working: true });
	});

	it("keeps a held limit past an empty execution's idle row, a repeated prompt's or a compaction's", () => {
		const limited = turn({ type: "provider.free-limit", message: "resets 5pm" });
		const repeat = [{ id: "msg_i2", type: "idle" }, ...limited];
		const compacted = [{ id: "msg_i3", type: "idle" }, { id: "msg_c1", type: "compaction" }, ...limited];
		const recovered = [{ id: "msg_i4", type: "idle" }, { id: "msg_a3", type: "assistant" }, ...limited];

		expect([resting(repeat), resting(compacted)]).toEqual([
			{ ...idle, limitBlocked: true, limitDetail: "resets 5pm" },
			{ ...idle, limitBlocked: true, limitDetail: "resets 5pm" },
		]);
		expect(resting(recovered)).toEqual(idle);
	});

	it("names a running compaction, the newest finished one, and skips a failed one", () => {
		const done = { id: "msg_c1", type: "compaction" };
		const running = { id: "msg_c2", type: "compaction" };
		const broke = { id: "msg_c3", type: "compaction", error: { type: "compaction.failed", message: "" } };
		const user = { id: "msg_u", type: "user" };
		const answer = { id: "msg_a", type: "assistant" };
		const going = { inProgress: "msg_c2", newestDone: "msg_c1" };

		expect(compactionsOf({ running: true, rows: [running, user, done] })).toEqual(going);
		expect(compactionsOf({ running: true, rows: [user, running, done] })).toEqual(going);
		expect(compactionsOf({ running: true, rows: [answer, running, done] })).toEqual({ newestDone: "msg_c2" });
		expect(compactionsOf({ running: false, rows: [running, done] })).toEqual({ newestDone: "msg_c2" });
		expect(compactionsOf({ running: false, rows: [broke] })).toEqual({});
		expect(derivedFromView(viewFromSnapshot({ running: true, permissions: [], rows: [running] }))).toEqual({
			...idle,
			working: true,
			compacting: true,
		});
	});
});

describe("the ids and versions a session reads", () => {
	it("derives one prompt id per delivery, in OpenCode's message form", () => {
		expect(promptIdOf("delivery-1")).toBe(promptIdOf("delivery-1"));
		expect(promptIdOf("delivery-1")).not.toBe(promptIdOf("delivery-2"));
		expect(promptIdOf("delivery-1")).toMatch(/^msg_/);
	});

	it("reads the version `opencode --version` prints", () => {
		expect(parseOpencodeVersion("opencode v2.2.5\n")).toBe("2.2.5");
		expect(parseOpencodeVersion("2.3.0-beta.1")).toBe("2.3.0-beta.1");
		expect(parseOpencodeVersion("command not found")).toBeUndefined();
	});
});
