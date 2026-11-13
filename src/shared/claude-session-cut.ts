////////////////////////////////
//  Interfaces & Types

/** CLI versions whose session file shape a built cut is known to resume under. */
export const CUT_CLI_VERSIONS: readonly string[] = ["2.1.323"];

/** Trim keeps the live segment; clear and compact cut above a chosen turn. */
export type CutMode = "trim" | "clear" | "compact";

export type CutRefusal =
	| "no_rows"
	| "cli_version"
	| "boundary_shape"
	| "unreadable_rows"
	| "nothing_to_trim"
	| "preserved_unresolved"
	| "target_missing"
	| "target_compacted"
	| "target_not_turn_start"
	| "target_mid_tool"
	| "tail_mid_tool"
	| "end_missing"
	| "late_message"
	| "nothing_above"
	| "summary_needed";

export interface CutRefused {
	ok: false;
	reason: CutRefusal;
	detail: string;
}

/** One row after the live boundary, without its text. */
export interface RowMeta {
	line: number;
	bytes: number;
	type: string;
	uuid?: string;
	at?: string;
	/** A user row that opens a turn: not a tool result, a summary or a sidechain row. */
	turnStart: boolean;
	/** Tool calls still unanswered before this row. */
	openTools: number;
	/** A message reached the session here: a turn start, or one absorbed mid-turn. */
	delivered: boolean;
	/** A turn start's own text. */
	text?: string;
	/** Rows this one names: a prompt's leaf, a file snapshot's message. */
	points: string[];
}

export interface BoundaryMeta {
	line: number;
	uuid: string;
	/** Its preserved rows, which sit before it in the file. */
	preservedLines: number[];
	/** Every preserved id is a row, and they are the chain from tail back to head. */
	preservedSound: boolean;
	preserved: string[];
	summaryLine: number | null;
	cumulativeDroppedTokens: number;
	postTokens: number;
	/** Its key set is one a cut knows. */
	known: boolean;
}

export interface SessionIndex {
	lines: number;
	unparsed: number;
	/** Lines after the live boundary that do not parse. A cut that keeps past one would lose it. */
	unreadable: number[];
	version: string | null;
	/** The newest of each header row. */
	header: Map<string, number>;
	boundary: BoundaryMeta | null;
	/** The live boundary's summary text. */
	standing: string | null;
	/** Rows after the live boundary, or every row when there is none. The last entry is the file's end. */
	tail: RowMeta[];
}

export interface CutRequest {
	mode: CutMode;
	/** The turn start to keep from. Unused by trim. */
	targetUuid?: string;
	/** The last row to keep; the file's end when absent. */
	throughUuid?: string;
	/** Ends the kept rows before the first later turn start whose text holds this. */
	endBefore?: string;
	/** A compact's summary, when the caller already holds it. */
	summaryText?: string;
	/** A plan while the session still writes: where the kept rows end is checked at the build. */
	liveTail?: boolean;
}

/** A chat row to find a turn by: its time, and its text when it is a message the session was sent. */
export interface TurnPick {
	at: number;
	text?: string;
}

export interface PickedTurn {
	uuid: string;
	/** The row's own text matched; otherwise the turn at or before its time. */
	exact: boolean;
}

export interface CutPlan {
	ok: true;
	mode: CutMode;
	/** The newest header rows, written first. */
	headerLines: number[];
	/** Lines kept verbatim, ascending. */
	keptLines: number[];
	/** Clear and compact: the segment a built boundary preserves. Trim builds none. */
	preserved: { head: string; tail: string; uuids: string[] } | null;
	/** Rows a summarizer folds: after the standing summary, above the target. */
	foldLines: number[];
	keptBytes: number;
	droppedBytes: number;
	droppedRows: number;
	/** The kept turn, for a confirmation. */
	from: { at: string | null; text: string } | null;
}

export interface BuildInputs {
	sessionId: string;
	/** Clear and compact: the built summary's text. */
	summaryText?: string;
	newId: () => string;
	now: () => Date;
}

export type Summarizer = (input: { standing: string | null; rows: string[] }) => Promise<string>;

export interface CutPorts {
	/** The source's lines, split on LF alone, readable more than once. Never opened for writing. */
	read: () => AsyncIterable<string>;
	/** Where the source is, for the summary to name. */
	sourcePath: string;
	/** Exclusive create of the new session's file. */
	create: (sessionId: string, lines: AsyncIterable<string>) => Promise<void>;
	/** The built file's lines, for the read-back. */
	readBuilt: (sessionId: string) => AsyncIterable<string>;
	/** Removes a built file that failed its read-back. */
	discard: (sessionId: string) => Promise<void>;
	newId: () => string;
	now: () => Date;
	cliVersion: () => Promise<string>;
	summarize?: Summarizer;
}

export interface CutDone {
	ok: true;
	sessionId: string;
	plan: CutPlan;
}

type Row = Record<string, unknown>;

////////////////////////////////
//  Functions & Helpers

const HEADER_TYPES = new Set(["mode", "permission-mode", "atis-latch", "session-owner"]);
/** The CLI's request log; a resume reads none of it. */
const SKIPPED_TYPES = new Set(["api-request", "api-request-blob", "api-request-shape"]);
const SESSION_KEYS = new Set(["sessionId", "session_id"]);
/** Keys under which a row names another row. */
const POINTER_KEYS = ["leafUuid", "messageId", "snapshotMessageId"];

/** The boundary a cut writes, in the CLI's own key order. */
const BOUNDARY_KEYS = [
	"parentUuid",
	"logicalParentUuid",
	"isSidechain",
	"type",
	"subtype",
	"content",
	"level",
	"compactMetadata",
	"uuid",
	"timestamp",
	"userType",
	"entrypoint",
	"cwd",
	"sessionId",
	"version",
	"gitBranch",
	"slug",
];
/** An automatic compaction's boundary also carries this. */
const BOUNDARY_EXTRA_KEYS = ["isMeta"];
const METADATA_KEYS = [
	"trigger",
	"preTokens",
	"postTokens",
	"cumulativeDroppedTokens",
	"durationMs",
	"preservedSegment",
	"preservedMessages",
];
const METADATA_EXTRA_KEYS = ["preCompactArtifactReadVersions"];
const ENVELOPE_KEYS = ["userType", "entrypoint", "cwd", "version", "gitBranch", "slug"];
/** A turn starts this long after its message was sent, at most. */
const PICK_SLACK_MS = 2000;

const refused = (reason: CutRefusal, detail: string): CutRefused => ({ ok: false, reason, detail });

const parse = (text: string): Row | null => {
	try {
		const row = JSON.parse(text) as unknown;
		return row && typeof row === "object" && !Array.isArray(row) ? (row as Row) : null;
	} catch {
		return null;
	}
};

const isBoundary = (row: Row) => row.type === "system" && row.subtype === "compact_boundary";

const partsOf = (row: Row): Row[] => {
	const content = (row.message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? (content.filter((part) => part && typeof part === "object") as Row[]) : [];
};

/** Tool call ids a conversation row opens and answers. The request log repeats messages and counts for neither. */
const callsOf = (row: Row): { opened: string[]; answered: string[] } => {
	const ids = (kind: string, key: string) =>
		partsOf(row)
			.filter((part) => part.type === kind)
			.map((part) => part[key])
			.filter((id): id is string => typeof id === "string");
	return {
		opened: row.type === "assistant" ? ids("tool_use", "id") : [],
		answered: row.type === "user" ? ids("tool_result", "tool_use_id") : [],
	};
};

const textOf = (row: Row): string | undefined => {
	const content = (row.message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	const parts = partsOf(row);
	if (parts.length === 0 || parts.some((part) => part.type === "tool_result")) return undefined;
	return parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
};

/** A message the CLI took in while a turn ran. */
const absorbed = (row: Row) =>
	row.type === "attachment" && (row.attachment as Row | undefined)?.type === "queued_command";

const pointsOf = (row: Row): string[] =>
	POINTER_KEYS.map((key) => row[key]).filter((id): id is string => typeof id === "string");

/** Every required key, and nothing outside the required and the allowed. */
const keysWithin = (value: unknown, required: string[], allowed: string[]) => {
	if (value === null || typeof value !== "object") return false;
	const keys = Object.keys(value as Row);
	return (
		required.every((key) => keys.includes(key)) &&
		keys.every((key) => required.includes(key) || allowed.includes(key))
	);
};

/** A rough count: the CLI reports these numbers and sums them. */
const tokensOf = (bytes: number) => Math.round(bytes / 4);

/** The end of the JSON string that opens at `from`. */
function stringEnd(text: string, from: number): number {
	let at = from + 1;
	while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
	return at;
}

/**
 * A row's bytes with its own session ids changed and nothing else: only top-level keys, found by depth,
 * so an id inside a tool input or a path is left alone.
 */
export function rehomed(text: string, sessionId: string): string {
	const spans: Array<[number, number]> = [];
	let depth = 0;
	for (let at = 0; at < text.length; at += 1) {
		const char = text[at];
		if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth -= 1;
		else if (char === '"') {
			const end = stringEnd(text, at);
			const key = text.slice(at + 1, end);
			at = end;
			if (depth !== 1 || text[end + 1] !== ":" || !SESSION_KEYS.has(key) || text[end + 2] !== '"') continue;
			const close = stringEnd(text, end + 2);
			spans.push([end + 2, close + 1]);
			at = close;
		}
	}
	let next = text;
	for (const [from, to] of spans.reverse()) next = next.slice(0, from) + JSON.stringify(sessionId) + next.slice(to);
	return next;
}

/** One pass over the file: the live boundary, the newest header rows, and the rows after it. */
export async function indexSession(lines: AsyncIterable<string>): Promise<SessionIndex> {
	const header = new Map<string, number>();
	let segment = new Map<string, { line: number; parent: unknown }>();
	let tail: RowMeta[] = [];
	let boundary: BoundaryMeta | null = null;
	let standing: string | null = null;
	let open = new Set<string>();
	let version: string | null = null;
	let unparsed = 0;
	let unreadable: number[] = [];
	let line = 0;

	for await (const text of lines) {
		line += 1;
		if (text.length === 0) continue;
		const row = parse(text);
		if (!row) {
			unparsed += 1;
			unreadable.push(line);
			continue;
		}
		const type = String(row.type);
		if (HEADER_TYPES.has(type)) header.set(type, line);
		if (typeof row.version === "string") version = row.version;
		const uuid = typeof row.uuid === "string" ? row.uuid : undefined;

		if (isBoundary(row)) {
			const meta = (row.compactMetadata ?? {}) as Row;
			const kept = (meta.preservedSegment ?? {}) as Row;
			const preserved = ((meta.preservedMessages as Row | undefined)?.uuids ?? []) as string[];
			const walk = new Set<string>();
			for (
				let id: unknown = kept.tailUuid;
				typeof id === "string" && !walk.has(id);
				id = segment.get(id)?.parent
			) {
				walk.add(id);
				if (id === kept.headUuid) break;
			}
			boundary = {
				line,
				uuid: uuid ?? "",
				preserved,
				preservedLines: preserved
					.map((id) => segment.get(id)?.line)
					.filter((at): at is number => at !== undefined),
				preservedSound:
					preserved.every((id) => segment.has(id) && walk.has(id)) && walk.size === preserved.length,
				summaryLine: null,
				cumulativeDroppedTokens: Number(meta.cumulativeDroppedTokens ?? 0),
				postTokens: Number(meta.postTokens ?? 0),
				known:
					keysWithin(row, BOUNDARY_KEYS, BOUNDARY_EXTRA_KEYS) &&
					keysWithin(meta, METADATA_KEYS, METADATA_EXTRA_KEYS),
			};
			segment = new Map();
			tail = [];
			open = new Set();
			standing = null;
			unreadable = [];
		}
		if (uuid) segment.set(uuid, { line, parent: row.parentUuid });
		if (boundary && boundary.summaryLine === null && row.isCompactSummary === true) {
			boundary.summaryLine = line;
			standing = textOf(row) ?? null;
		}

		const openTools = open.size;
		const calls = callsOf(row);
		for (const id of calls.opened) open.add(id);
		for (const id of calls.answered) open.delete(id);
		const opens =
			type === "user" && row.isCompactSummary !== true && row.isSidechain !== true ? textOf(row) : undefined;
		tail.push({
			line,
			bytes: Buffer.byteLength(text) + 1,
			type,
			...(uuid ? { uuid } : {}),
			...(typeof row.timestamp === "string" ? { at: row.timestamp } : {}),
			turnStart: opens !== undefined,
			openTools,
			delivered: opens !== undefined || absorbed(row),
			...(opens !== undefined ? { text: opens } : {}),
			points: pointsOf(row),
		});
	}
	tail.push({
		line: line + 1,
		bytes: 0,
		type: "end",
		turnStart: false,
		openTools: open.size,
		delivered: false,
		points: [],
	});
	return { lines: line, unparsed, unreadable, version, header, boundary, standing, tail };
}

/** What a cut keeps and drops, or why it is refused. Writes nothing. */
export function planCut(index: SessionIndex, request: CutRequest, cliVersion: string): CutPlan | CutRefused {
	const rows = index.tail.slice(0, -1);
	const end = index.tail.at(-1);
	if (rows.length === 0 || !end) return refused("no_rows", "the session file holds no rows");
	if (
		!CUT_CLI_VERSIONS.includes(cliVersion) ||
		(index.version !== null && !CUT_CLI_VERSIONS.includes(index.version))
	) {
		return refused(
			"cli_version",
			`Claude Code ${cliVersion}, file last written by ${index.version ?? "an unknown version"}`,
		);
	}
	const live = index.boundary;
	if (live && !live.known)
		return refused("boundary_shape", "the file's own compaction row is not a shape a cut knows");
	const unreadable = (from: number, to: number) =>
		index.unreadable.some((line) => line >= from && line <= to)
			? refused("unreadable_rows", "a row the cut would keep past does not parse")
			: null;
	const headerLines = [...index.header.values()].sort((a, b) => a - b);
	const writes = (row: RowMeta) => !SKIPPED_TYPES.has(row.type);
	const resolving = (range: RowMeta[], held: Set<string>) =>
		range.filter((row) => writes(row) && row.points.every((id) => held.has(id)));
	const size = (range: RowMeta[]) => range.reduce((sum, row) => sum + row.bytes, 0);

	if (request.mode === "trim") {
		if (!live) return refused("nothing_to_trim", "the session has never compacted");
		if (!live.preservedSound)
			return refused("preserved_unresolved", "the last compaction's preserved rows are not all in the file");
		const torn = unreadable(live.line, end.line);
		if (torn) return torn;
		const held = new Set([
			...live.preserved,
			...rows.map((row) => row.uuid).filter((id): id is string => id !== undefined),
		]);
		const kept = resolving(rows, held);
		return {
			ok: true,
			mode: "trim",
			headerLines,
			keptLines: [...live.preservedLines, ...kept.map((row) => row.line)].sort((a, b) => a - b),
			preserved: null,
			foldLines: [],
			keptBytes: size(kept),
			droppedBytes: 0,
			droppedRows: live.line - 1 - live.preservedLines.length,
			from: null,
		};
	}

	const at = rows.findIndex((row) => row.uuid !== undefined && row.uuid === request.targetUuid);
	if (at < 0) {
		return live
			? refused("target_compacted", "that row is not after the session's last compaction")
			: refused("target_missing", "that row is not in the session");
	}
	const target = rows[at] as RowMeta;
	if (!target.turnStart) return refused("target_not_turn_start", "a cut starts at a message, not inside a turn");
	if (target.openTools > 0) return refused("target_mid_tool", "a tool call above that row is still unanswered");
	let through = rows.length - 1;
	if (request.endBefore !== undefined) {
		const marker = request.endBefore;
		const stop = rows.findIndex((row, i) => i > at && row.turnStart && row.text?.includes(marker) === true);
		if (stop < 0) return refused("end_missing", "the message the kept rows end before is not in the session");
		if (rows.slice(stop + 1).some((row) => row.delivered))
			return refused("late_message", "a message reached the session after the summary was asked for");
		through = stop - 1;
	} else if (request.throughUuid !== undefined) {
		through = rows.findIndex((row) => row.uuid === request.throughUuid);
	}
	if (through < at) return refused("target_missing", "the last row to keep is not at or after the first");
	const torn = unreadable(target.line, (rows[through] as RowMeta).line);
	if (torn) return torn;
	if (!request.liveTail && (rows[through + 1] ?? end).openTools > 0)
		return refused("tail_mid_tool", "the kept rows end inside a tool call");
	const above = rows.slice(0, at).filter((row) => row.line > (live?.summaryLine ?? 0) && row.uuid !== undefined);
	if (above.length === 0) return refused("nothing_above", "nothing above that row to cut");

	const range = rows.slice(at, through + 1);
	const chain = range.map((row) => row.uuid).filter((id): id is string => id !== undefined);
	const kept = resolving(range, new Set(chain));
	return {
		ok: true,
		mode: request.mode,
		headerLines,
		keptLines: kept.map((row) => row.line),
		preserved: { head: chain[0] as string, tail: chain.at(-1) as string, uuids: chain },
		foldLines: [...(live?.preservedLines ?? []), ...above.filter(writes).map((row) => row.line)],
		keptBytes: size(kept),
		droppedBytes: size(rows) - size(kept),
		droppedRows: above.length + (live?.preservedLines.length ?? 0),
		from: { at: target.at ?? null, text: target.text ?? "" },
	};
}

/** The new file's lines: the header, the kept rows, then for a clear or compact a built boundary and summary. */
export async function* buildCut(
	plan: CutPlan,
	index: SessionIndex,
	lines: AsyncIterable<string>,
	inputs: BuildInputs,
): AsyncGenerator<string> {
	const header = new Set(plan.headerLines);
	const kept = new Set(plan.keptLines);
	const headers: string[] = [];
	const body: string[] = [];
	let envelope: Row = {};
	let position: unknown;
	let line = 0;
	for await (const text of lines) {
		line += 1;
		if (header.has(line)) headers.push(rehomed(text, inputs.sessionId));
		if (!kept.has(line)) continue;
		body.push(rehomed(text, inputs.sessionId));
		const row = parse(text);
		if (typeof row?.uuid === "string") envelope = row;
		if (row?.turnPosition !== undefined) position = row.turnPosition;
	}
	yield* headers;
	yield* body;
	if (!plan.preserved) return;

	const boundaryUuid = inputs.newId();
	const summaryUuid = inputs.newId();
	const at = inputs.now().toISOString();
	const carried = Object.fromEntries(ENVELOPE_KEYS.map((key) => [key, envelope[key]]));
	const before = tokensOf(plan.keptBytes + plan.droppedBytes) + (index.boundary?.postTokens ?? 0);
	const after = Math.min(before, tokensOf(plan.keptBytes + Buffer.byteLength(inputs.summaryText ?? "")));
	const boundary: Row = {
		parentUuid: null,
		logicalParentUuid: plan.preserved.tail,
		isSidechain: false,
		type: "system",
		subtype: "compact_boundary",
		content: "Conversation compacted",
		level: "info",
		compactMetadata: {
			trigger: "manual",
			preTokens: before,
			postTokens: after,
			cumulativeDroppedTokens: (index.boundary?.cumulativeDroppedTokens ?? 0) + before - after,
			durationMs: 1,
			preservedSegment: { headUuid: plan.preserved.head, anchorUuid: summaryUuid, tailUuid: plan.preserved.tail },
			preservedMessages: { anchorUuid: summaryUuid, uuids: plan.preserved.uuids, allUuids: plan.preserved.uuids },
		},
		uuid: boundaryUuid,
		timestamp: at,
		userType: carried.userType,
		entrypoint: carried.entrypoint,
		cwd: carried.cwd,
		sessionId: inputs.sessionId,
		version: carried.version,
		gitBranch: carried.gitBranch,
		slug: carried.slug,
	};
	yield JSON.stringify(boundary);
	yield JSON.stringify({
		parentUuid: boundaryUuid,
		isSidechain: false,
		promptId: inputs.newId(),
		type: "user",
		message: { role: "user", content: inputs.summaryText ?? "" },
		isVisibleInTranscriptOnly: true,
		isCompactSummary: true,
		uuid: summaryUuid,
		timestamp: at,
		...(position !== undefined ? { turnPosition: position } : {}),
		session_id: inputs.sessionId,
		userType: carried.userType,
		entrypoint: carried.entrypoint,
		cwd: carried.cwd,
		sessionId: inputs.sessionId,
		version: carried.version,
		gitBranch: carried.gitBranch,
		slug: carried.slug,
	});
}

/**
 * The read-back: what would stop the built file resuming as planned. Empty when sound.
 * `paired` holds a built segment to its own tool calls; a trim keeps the CLI's own segment as it stood.
 */
export async function verifyCut(lines: AsyncIterable<string>, sessionId: string, paired: boolean): Promise<string[]> {
	const problems: string[] = [];
	const seen = new Map<string, number>();
	const pointers: Array<{ line: number; id: string }> = [];
	let boundary: { line: number; row: Row } | null = null;
	let afterBoundary: Row | null = null;
	const calls = new Set<string>();
	let line = 0;
	for await (const text of lines) {
		line += 1;
		const row = parse(text);
		if (!row) {
			problems.push(`line ${line} does not parse`);
			continue;
		}
		if (SKIPPED_TYPES.has(String(row.type))) problems.push(`line ${line} is a request log row`);
		for (const key of SESSION_KEYS) {
			if (typeof row[key] === "string" && row[key] !== sessionId)
				problems.push(`line ${line} names another session`);
		}
		for (const id of pointsOf(row)) pointers.push({ line, id });
		if (boundary && line === boundary.line + 1) afterBoundary = row;
		if (isBoundary(row)) {
			if (boundary) problems.push(`line ${line} is a second compaction row`);
			boundary = { line, row };
			afterBoundary = null;
		}
		if (typeof row.uuid === "string") seen.set(row.uuid, line);
		const made = callsOf(row);
		for (const id of made.opened) calls.add(id);
		if (paired && made.answered.some((id) => !calls.has(id))) {
			problems.push(`line ${line} answers a call that is not in the file`);
		}
	}
	for (const { line: at, id } of pointers)
		if (!seen.has(id)) problems.push(`line ${at} names a row that is not in the file`);
	if (!boundary) return [...problems, "no compaction row"];

	const meta = (boundary.row.compactMetadata ?? {}) as Row;
	const segment = (meta.preservedSegment ?? {}) as Row;
	const messages = (meta.preservedMessages ?? {}) as Row;
	const uuids = (messages.uuids ?? []) as string[];
	const places = uuids.map((id) => seen.get(id));
	if (places.some((at) => at === undefined || at > boundary.line))
		problems.push("a preserved row is missing or after the compaction row");
	if (places.some((at, i) => i > 0 && (at ?? 0) < (places[i - 1] ?? 0)))
		problems.push("preserved rows are not in conversation order");
	if (uuids.length > 0 && (segment.headUuid !== uuids[0] || segment.tailUuid !== uuids.at(-1))) {
		problems.push("the preserved segment's ends are not its rows' ends");
	}
	if (boundary.row.parentUuid !== null) problems.push("the compaction row has a parent");
	const summary =
		afterBoundary?.isCompactSummary === true && afterBoundary.parentUuid === boundary.row.uuid
			? afterBoundary
			: null;
	if (!summary) problems.push("no summary follows the compaction row");
	else if (summary.uuid !== segment.anchorUuid || summary.uuid !== messages.anchorUuid) {
		problems.push("the summary is not the compaction row's anchor");
	}
	return problems;
}

const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The turn a chat row names. Its own text finds it, nearest in time; a row that started no turn finds the
 * turn start at or before it. `bodyOf` reads a turn start's text as the message it carried.
 */
export function pickTurn(
	index: SessionIndex,
	pick: TurnPick,
	bodyOf: (text: string) => string = (text) => text,
): PickedTurn | null {
	const starts = index.tail.filter(
		(row): row is RowMeta & { uuid: string } => row.turnStart && row.openTools === 0 && row.uuid !== undefined,
	);
	const timeOf = (row: RowMeta) => (row.at === undefined ? Number.NaN : Date.parse(row.at));
	if (pick.text !== undefined && collapsed(pick.text).length > 0) {
		const wanted = collapsed(pick.text);
		const named = starts
			.filter((row) => collapsed(bodyOf(row.text ?? "")) === wanted)
			.map((row) => ({ row, gap: Math.abs(timeOf(row) - pick.at) }))
			.filter((held) => !Number.isNaN(held.gap))
			.sort((a, b) => a.gap - b.gap)[0];
		if (named) return { uuid: named.row.uuid, exact: true };
	}
	// A sent message's turn starts after it.
	const slack = pick.text === undefined ? 0 : PICK_SLACK_MS;
	const before = starts.filter((row) => timeOf(row) <= pick.at + slack).at(-1);
	return before ? { uuid: before.uuid, exact: false } : null;
}

/** A compact's summary row: the summary, framed as the CLI frames its own. */
export function compactedSummary(summary: string, sourcePath: string): string {
	return `
This session is being continued from an earlier part of this conversation, which the owner compacted above a message they chose. The summary below covers everything before that message.

${summary.trim()}

If you need specific details from before the compaction, read the full transcript at: ${sourcePath}

The messages after this summary are the conversation from that message on, kept verbatim.
	`.trim();
}

/** A clear's summary: what stood, then one line saying rows were cleared and where they still are. */
export function clearedSummary(standing: string | null, plan: CutPlan, sourcePath: string): string {
	const note = `[The owner cleared ${plan.droppedRows} earlier rows of this conversation without summarizing them. They remain in the transcript at: ${sourcePath}]`;
	return standing ? `${standing}\n\n${note}` : note;
}

/** The whole cut over its ports. The caller closes the CLI first and relaunches it after. */
export async function cutSession(ports: CutPorts, request: CutRequest): Promise<CutDone | CutRefused> {
	const index = await indexSession(ports.read());
	const plan = planCut(index, request, await ports.cliVersion());
	if (!plan.ok) return plan;

	let summaryText: string | undefined;
	if (plan.mode === "clear") summaryText = clearedSummary(index.standing, plan, ports.sourcePath);
	if (plan.mode === "compact") {
		let summary = request.summaryText;
		if (summary === undefined) {
			if (!ports.summarize) return refused("summary_needed", "no summarizer is set up for a compact");
			const fold = new Set(plan.foldLines);
			const rows: string[] = [];
			let line = 0;
			for await (const text of ports.read()) {
				line += 1;
				if (fold.has(line)) rows.push(text);
			}
			summary = await ports.summarize({ standing: index.standing, rows });
		}
		if (summary.trim().length === 0) return refused("summary_needed", "the summary is empty");
		summaryText = compactedSummary(summary, ports.sourcePath);
	}

	const sessionId = ports.newId();
	await ports.create(
		sessionId,
		buildCut(plan, index, ports.read(), {
			sessionId,
			newId: ports.newId,
			now: ports.now,
			...(summaryText !== undefined ? { summaryText } : {}),
		}),
	);
	const problems = await verifyCut(ports.readBuilt(sessionId), sessionId, plan.preserved !== null);
	if (problems.length > 0) {
		await ports.discard(sessionId);
		throw new Error(`the built session file failed its read-back: ${problems.slice(0, 4).join("; ")}`);
	}
	return { ok: true, sessionId, plan };
}
