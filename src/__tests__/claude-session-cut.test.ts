import { describe, expect, it } from "vitest";
import { channelBodyOf } from "../shared/channel-row.js";
import {
	type CutPorts,
	type CutRequest,
	cutSession,
	indexSession,
	pickTurn,
	planCut,
	rehomed,
	verifyCut,
} from "../shared/claude-session-cut.js";
import { reminderBlock } from "../shared/system-reminder.js";

const OLD = "11111111-1111-4111-8111-111111111111";
const VERSION = "2.1.323";

async function* each(lines: string[]): AsyncGenerator<string> {
	yield* lines;
}

/** A session file as the CLI writes one: compact JSON, one row a line. */
class Session {
	readonly lines: string[] = [];
	private last: string | null = null;
	private count = 0;

	private chain(row: Record<string, unknown>, id?: string): string {
		const uuid = id ?? `u${++this.count}`;
		this.lines.push(
			JSON.stringify({
				parentUuid: this.last,
				isSidechain: false,
				...row,
				uuid,
				timestamp: `2026-11-13T00:00:${String(this.count).padStart(2, "0")}.000Z`,
				userType: "external",
				entrypoint: "cli",
				cwd: "/work",
				sessionId: OLD,
				version: VERSION,
				gitBranch: "main",
				slug: "a-slug",
			}),
		);
		this.last = uuid;
		return uuid;
	}

	header() {
		for (const type of ["mode", "permission-mode", "session-owner", "atis-latch"])
			this.lines.push(JSON.stringify({ type, sessionId: OLD }));
	}

	user(text: string) {
		return this.chain({ type: "user", message: { role: "user", content: text } });
	}

	says(text: string) {
		return this.chain({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
	}

	calls(id: string) {
		return this.chain({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id, name: "Bash", input: { session_id: OLD } }],
			},
		});
	}

	answers(id: string) {
		return this.chain({
			type: "user",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `ran in ${OLD}` }] },
		});
	}

	requestLog(id: string) {
		this.lines.push(
			JSON.stringify({
				type: "api-request-blob",
				sessionId: OLD,
				hash: "h",
				message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
			}),
		);
	}

	lastPrompt(leaf: string) {
		this.lines.push(JSON.stringify({ type: "last-prompt", leafUuid: leaf, sessionId: OLD }));
	}

	/** The CLI's own compaction, preserving these rows. */
	compacts(summary: string, preserved: string[], dropped = 1000) {
		const boundary = `b${++this.count}`;
		const anchor = `s${this.count}`;
		this.lines.push(
			JSON.stringify({
				parentUuid: null,
				logicalParentUuid: this.last,
				isSidechain: false,
				type: "system",
				subtype: "compact_boundary",
				content: "Conversation compacted",
				level: "info",
				compactMetadata: {
					trigger: "manual",
					preTokens: 5000,
					postTokens: 400,
					cumulativeDroppedTokens: dropped,
					durationMs: 9,
					preservedSegment: { headUuid: preserved[0], anchorUuid: anchor, tailUuid: preserved.at(-1) },
					preservedMessages: { anchorUuid: anchor, uuids: preserved, allUuids: [...preserved, "gone"] },
				},
				uuid: boundary,
				timestamp: "2026-11-13T00:01:00.000Z",
				userType: "external",
				entrypoint: "cli",
				cwd: "/work",
				sessionId: OLD,
				version: VERSION,
				gitBranch: "main",
				slug: "a-slug",
			}),
		);
		this.last = boundary;
		this.chain(
			{
				type: "user",
				message: { role: "user", content: summary },
				isCompactSummary: true,
				isVisibleInTranscriptOnly: true,
			},
			anchor,
		);
	}
}

/** Ports over an in-memory file. */
function portsOver(source: string[], summarize?: CutPorts["summarize"]) {
	const built = new Map<string, string[]>();
	let minted = 0;
	const ports: CutPorts = {
		read: () => each(source),
		sourcePath: "/sessions/old.jsonl",
		create: async (id, lines) => {
			const rows: string[] = [];
			for await (const line of lines) rows.push(line);
			built.set(id, rows);
		},
		readBuilt: (id) => each(built.get(id) ?? []),
		discard: async (id) => void built.delete(id),
		newId: () => `new-${++minted}`,
		now: () => new Date("2026-11-13T02:00:00.000Z"),
		cliVersion: async () => VERSION,
		...(summarize ? { summarize } : {}),
	};
	return { ports, built };
}

/** A compacted session with three turns after its boundary. */
function compacted() {
	const session = new Session();
	session.header();
	session.user("ancient");
	session.says("ancient answer");
	const keptA = session.user("kept before the compaction");
	const keptB = session.says("kept answer");
	session.compacts("what stood", [keptA, keptB]);
	session.user("first turn");
	session.calls("t1");
	session.requestLog("ghost");
	session.answers("t1");
	session.says("done");
	const second = session.user("second turn");
	session.lastPrompt(second);
	session.calls("t2");
	session.answers("t2");
	const midTurn = session.user("typed while it worked");
	session.says("both done");
	const third = session.user("third turn");
	session.header();
	const end = session.says("finished");
	session.lastPrompt(end);
	return { session, second, third, midTurn, keptA };
}

const cut = async (source: string[], request: CutRequest, summarize?: CutPorts["summarize"]) => {
	const { ports, built } = portsOver(source, summarize);
	const result = await cutSession(ports, request);
	return {
		result,
		rows: result.ok ? (built.get(result.sessionId) ?? []).map((line) => JSON.parse(line)) : [],
		built,
	};
};

describe("claude session cut", () => {
	it("clears above a turn: the kept rows stay byte for byte, behind a boundary that preserves them in order", async () => {
		const { session, second } = compacted();
		const { result, rows, built } = await cut(session.lines, { mode: "clear", targetUuid: second });
		if (!result.ok) throw new Error(result.detail);

		const raw = built.get(result.sessionId) ?? [];
		const keptSource = session.lines.slice(session.lines.findIndex((line) => line.includes(`"uuid":"${second}"`)));
		const body = raw.slice(4, 4 + keptSource.length);
		expect(body.map((line) => rehomed(line, OLD))).toEqual(keptSource);
		// Only the row's own id moved: the tool input and the result text still name the old session.
		expect(body.join("\n")).toContain(`"input":{"session_id":"${OLD}"}`);
		expect(body.join("\n")).toContain(`ran in ${OLD}`);

		const boundary = rows.at(-2);
		const summary = rows.at(-1);
		const chain = body.map((line) => JSON.parse(line).uuid).filter(Boolean);
		expect(boundary.compactMetadata.preservedMessages.uuids).toEqual(chain);
		expect(boundary.compactMetadata.preservedSegment).toEqual({
			headUuid: second,
			anchorUuid: summary.uuid,
			tailUuid: chain.at(-1),
		});
		expect(boundary.parentUuid).toBeNull();
		expect(summary.parentUuid).toBe(boundary.uuid);
		expect(summary.message.content).toContain("what stood");
		expect(summary.message.content).toContain("/sessions/old.jsonl");
		expect(rows.every((row) => row.sessionId === undefined || row.sessionId === result.sessionId)).toBe(true);
	});

	it("keeps the CLI's own sum: what stood, plus what this cut dropped", async () => {
		const { session, second } = compacted();
		const { rows } = await cut(session.lines, { mode: "clear", targetUuid: second });
		const meta = rows.at(-2).compactMetadata;
		expect(meta.cumulativeDroppedTokens).toBe(1000 + meta.preTokens - meta.postTokens);
		expect(meta.preTokens).toBeGreaterThanOrEqual(meta.postTokens);
	});

	it("trims to the live segment and its preserved rows, copying the CLI's own boundary", async () => {
		const { session, keptA } = compacted();
		const { result, rows, built } = await cut(session.lines, { mode: "trim" });
		if (!result.ok) throw new Error(result.detail);

		const texts = rows.map((row) => row.message?.content).filter((content) => typeof content === "string");
		expect(texts).not.toContain("ancient");
		expect(texts.slice(0, 3)).toEqual(["kept before the compaction", "what stood", "first turn"]);
		const boundaries = rows.filter((row) => row.subtype === "compact_boundary");
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0].compactMetadata.preservedSegment.headUuid).toBe(keptA);
		const raw = built.get(result.sessionId) ?? [];
		const source = session.lines.find((line) => line.includes('"subtype":"compact_boundary"')) ?? "";
		expect(raw.map((line) => rehomed(line, OLD))).toContain(source);
	});

	it("leaves out the request log and a pointer whose row was cut", async () => {
		const { session, third } = compacted();
		const { rows } = await cut(session.lines, { mode: "clear", targetUuid: third });
		expect(rows.some((row) => row.type === "api-request-blob")).toBe(false);
		const held = new Set(rows.map((row) => row.uuid));
		expect(rows.filter((row) => row.type === "last-prompt").every((row) => held.has(row.leafUuid))).toBe(true);
		expect(rows.filter((row) => row.type === "last-prompt")).toHaveLength(1);
	});

	it("cuts at a message typed mid-turn once every call above it is answered, and nowhere inside a call", async () => {
		const { session, midTurn } = compacted();
		const index = await indexSession(each(session.lines));
		const answer = index.tail.find((row) => row.type === "user" && !row.turnStart);
		const refusal = (request: CutRequest) => {
			const plan = planCut(index, request, VERSION);
			return plan.ok ? "planned" : plan.reason;
		};

		expect(refusal({ mode: "clear", targetUuid: midTurn })).toBe("planned");
		expect(refusal({ mode: "clear", targetUuid: answer?.uuid })).toBe("target_not_turn_start");
		expect(refusal({ mode: "clear", targetUuid: "nowhere" })).toBe("target_compacted");
		expect(refusal({ mode: "compact", targetUuid: midTurn })).toBe("planned");

		const open = new Session();
		open.user("one");
		open.calls("pending");
		const typed = open.user("typed before the answer");
		open.answers("pending");
		const later = await indexSession(each(open.lines));
		const plan = planCut(later, { mode: "clear", targetUuid: typed }, VERSION);
		expect(plan.ok ? "planned" : plan.reason).toBe("target_mid_tool");
	});

	it("refuses a CLI or a file shape it has not been proven on, and rows it cannot read", async () => {
		const { session, second } = compacted();
		const index = await indexSession(each(session.lines));
		const reason = (plan: ReturnType<typeof planCut>) => (plan.ok ? "planned" : plan.reason);
		expect(reason(planCut(index, { mode: "clear", targetUuid: second }, "2.2.0"))).toBe("cli_version");

		const odd = session.lines.map((line) =>
			line.includes('"subtype":"compact_boundary"')
				? line.replace('"level":"info"', '"level":"info","surprise":1')
				: line,
		);
		expect(reason(planCut(await indexSession(each(odd)), { mode: "trim" }, VERSION))).toBe("boundary_shape");

		const torn = [...session.lines, '{"type":"user","uuid":"torn'];
		expect(reason(planCut(await indexSession(each(torn)), { mode: "trim" }, VERSION))).toBe("unreadable_rows");

		const fresh = new Session();
		fresh.user("only turn");
		expect(reason(planCut(await indexSession(each(fresh.lines)), { mode: "trim" }, VERSION))).toBe(
			"nothing_to_trim",
		);
	});

	it("compacts through a summarizer handed what stood and the rows above the cut", async () => {
		const { session, third } = compacted();
		const seen: { standing: string | null; rows: number }[] = [];
		const { result, rows } = await cut(session.lines, { mode: "compact", targetUuid: third }, async (input) => {
			seen.push({ standing: input.standing, rows: input.rows.length });
			return "folded";
		});
		expect(result.ok).toBe(true);
		expect(seen).toEqual([{ standing: "what stood", rows: 11 }]);
		expect(rows.at(-1).message.content).toContain("\n\nfolded\n\n");
		expect(rows.at(-1).message.content).toContain("/sessions/old.jsonl");

		const none = await cut(session.lines, { mode: "compact", targetUuid: third });
		expect(none.result).toMatchObject({ ok: false, reason: "summary_needed" });
	});

	it("compacts with a summary it is handed, ending the kept rows before the request that asked for it", async () => {
		const { session, second } = compacted();
		const kept = session.lines.length;
		session.user('Owner asked to compact. Call the tool with cutId "cut-00aa".');
		session.calls("t9");
		const source = [...session.lines, '{"type":"assistant","uuid":"torn'];
		const request: CutRequest = {
			mode: "compact",
			targetUuid: second,
			endBefore: "cut-00aa",
			summaryText: "handed",
		};
		const { result, rows } = await cut(source, request);
		if (!result.ok) throw new Error(result.detail);

		expect(rows.at(-1).message.content).toContain("handed");
		expect(JSON.stringify(rows)).not.toContain("cut-00aa");
		expect(result.plan.keptLines.at(-1)).toBe(kept);

		const answered = [...session.lines];
		const late = new Session();
		late.lines.push(...answered);
		late.lines.push(
			JSON.stringify({
				type: "attachment",
				uuid: "late-1",
				parentUuid: "u-last",
				attachment: { type: "queued_command", prompt: "one more thing" },
				sessionId: OLD,
			}),
		);
		expect((await cut(late.lines, request)).result).toMatchObject({ ok: false, reason: "late_message" });

		const unasked = await cut(source, { ...request, endBefore: "cut-ffff" });
		expect(unasked.result).toMatchObject({ ok: false, reason: "end_missing" });
		// Kept to the end, the open call and the torn row both stop it.
		const { endBefore: _end, ...whole } = request;
		expect((await cut(session.lines, whole)).result).toMatchObject({ ok: false, reason: "tail_mid_tool" });
	});

	it("finds a chat row's turn by its text, nearest in time, and otherwise the turn at or before it", async () => {
		const session = new Session();
		session.header();
		const first = session.user("go");
		session.says("went");
		const tagged = session.user(
			`<channel source="plugin:switchboard:switchboard" session_id="conv.a" from="Phone">\n[FILES]\n- a.png\n[/FILES]\n\n${reminderBlock(["act: no_act"])}\n\nship   it\n</channel>`,
		);
		session.calls("t1");
		session.user("typed while it worked");
		session.answers("t1");
		session.says("shipped");
		const again = session.user("go");
		session.says("went again");
		const index = await indexSession(each(session.lines));
		const at = (second: number) => Date.parse(`2026-11-13T00:00:${String(second).padStart(2, "0")}.000Z`);

		expect(pickTurn(index, { at: at(1), text: "go" }, channelBodyOf)).toEqual({ uuid: first, exact: true });
		expect(pickTurn(index, { at: at(9), text: "go" }, channelBodyOf)).toEqual({ uuid: again, exact: true });
		expect(pickTurn(index, { at: at(3), text: "ship it" }, channelBodyOf)).toEqual({ uuid: tagged, exact: true });
		// Typed mid-call, and a reply: neither starts a turn a cut can keep from.
		expect(pickTurn(index, { at: at(5), text: "typed while it worked" })).toEqual({ uuid: tagged, exact: false });
		expect(pickTurn(index, { at: at(7) })).toEqual({ uuid: tagged, exact: false });
		expect(pickTurn(index, { at: at(0) - 60_000 })).toBeNull();
	});

	it("reads a built file back for what would stop it resuming", async () => {
		const { session, second } = compacted();
		const { result, built } = await cut(session.lines, { mode: "clear", targetUuid: second });
		if (!result.ok) throw new Error(result.detail);
		const sound = built.get(result.sessionId) ?? [];
		expect(await verifyCut(each(sound), result.sessionId, true)).toEqual([]);

		const reordered = sound.map((line) => {
			const row = JSON.parse(line);
			if (row.subtype !== "compact_boundary") return line;
			row.compactMetadata.preservedMessages.uuids.reverse();
			return JSON.stringify(row);
		});
		expect(await verifyCut(each(reordered), result.sessionId, true)).toContain(
			"preserved rows are not in conversation order",
		);
		expect(await verifyCut(each(sound.slice(0, -1)), result.sessionId, true)).toContain(
			"no summary follows the compaction row",
		);
		expect(await verifyCut(each(sound), "another-id", true)).toContain("line 1 names another session");
	});
});
