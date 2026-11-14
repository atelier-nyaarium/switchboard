import { z } from "zod";
import { AGENT_BACKEND_IDS, type AgentBackendId } from "./agent-backend.js";
import { type AgentExecutionTarget, AgentExecutionTargetSchema } from "./agent-execution-target.js";
import { AGENT_PROMPT_MAX_BYTES } from "./agent-record.js";
import { WINDOWS_SPAWN } from "./host-spawn.js";
import type { LaunchFailure } from "./launch-notice.js";
import { DEVICE_MAX_RECORDS, DeviceCandidateSchema, DeviceNearbySchema } from "./schemasDevices.js";
import type { HostSessionCutOp } from "./schemasSessionCut.js";
import type { SessionHarness, UNPICKED_WORD } from "./session-harness.js";
import { MAX_SLUG_LEN, SLUG_RE } from "./session-id.js";

export interface TmuxTarget {
	kind: "host" | "devcontainer";
	name: string;
	sessionName: string;
}

// Validated at both boundaries.
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"Enter",
	"Escape",
	"C-c",
	"C-o",
	"C-t",
	"Up",
	"Down",
	"Left",
	"Right",
	"PageUp",
	"PageDown",
	"Tab",
	"BTab",
	"BSpace",
	"M-BSpace",
]);

/** An address segment. */
export const TMUX_NAME_RE = SLUG_RE;
export const MAX_TMUX_NAME_LEN = MAX_SLUG_LEN;
export function isTmuxName(name: string): boolean {
	return name.length <= MAX_TMUX_NAME_LEN && TMUX_NAME_RE.test(name);
}
export function assertTmuxName(name: string): void {
	if (!isTmuxName(name)) throw new Error(`invalid tmux name "${name}"`);
}

// Reserved: daemon supervisor session.
export const RESERVED_HOST_SESSIONS: ReadonlySet<string> = new Set(["host-daemon"]);
export function isReservedHostSession(session: string): boolean {
	return RESERVED_HOST_SESSIONS.has(session);
}

export const MAX_WORKDIR_PATH_LEN = 512;
const WORKDIR_PATH_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}'"`$\\]/u;
export function isWorkdirPath(path: string): boolean {
	if (path.length === 0 || path.length > MAX_WORKDIR_PATH_LEN) return false;
	if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/")) return false;
	return !WORKDIR_PATH_FORBIDDEN.test(path);
}

const WINDOWS_WORKDIR_PATH_RE = /^[A-Za-z]:\//;
export function isWindowsWorkdirPath(path: string): boolean {
	if (path.length === 0 || path.length > MAX_WORKDIR_PATH_LEN) return false;
	if (!WINDOWS_WORKDIR_PATH_RE.test(path)) return false;
	return !WORKDIR_PATH_FORBIDDEN.test(path);
}

export function isSpawnWorkdirPath(spawn: string | undefined, path: string): boolean {
	if (spawn === WINDOWS_SPAWN) return isWindowsWorkdirPath(path) || isWorkdirPath(path);
	return isWorkdirPath(path);
}

/** One typed key's retry window, and so the daemon's hold. */
export const TYPED_GIVE_UP_MS = 15 * 60_000;

export const CONVERSATION_ID_RE = SLUG_RE;
export const MAX_CONVERSATION_ID_LEN = 128;

export type HostOp =
	| { kind: "peek"; target: TmuxTarget }
	| { kind: "kasaScan" }
	| { kind: "bleScan" }
	| { kind: "wifiNetwork" }
	| { kind: "typeIntoPane"; target: TmuxTarget; text: string; dedupKey?: string }
	// Mutations replay by dedupKey.
	| { kind: "sendText"; target: TmuxTarget; text: string; submit?: boolean; dedupKey?: string }
	| { kind: "sendKey"; target: TmuxTarget; key: string; dedupKey?: string }
	| {
			kind: "answerPrompt";
			target: TmuxTarget;
			promptId: string;
			decision: PromptDecision;
			reason?: string;
			dedupKey?: string;
	  }
	| { kind: "listDirs"; path: string; spawn?: string }
	| { kind: "readSkill"; target: AgentExecutionTarget; path: string }
	| { kind: "agentModels"; backend: AgentBackendId; target: AgentExecutionTarget }
	| HostClaudeRunOp
	| HostClaudeCancelOp
	| { kind: "reloadPlugins"; target: TmuxTarget; dedupKey?: string }
	| { kind: "killSession"; target: TmuxTarget; dedupKey?: string }
	| HostPurgeOp
	| HostSessionCutOp
	| { kind: "threads"; backend: AgentBackendId; target: AgentExecutionTarget }
	// Answered once queued; the outcome rides the container state.
	| { kind: "containerStart"; project: string; dedupKey?: string }
	| { kind: "containerStop"; project: string; dedupKey?: string };

// FIXME 2026-11-24: remove, once every Gateway creates through the wake.
export interface LegacyCreateSessionOp {
	kind: "createSession";
	target: TmuxTarget;
	workdirHint?: string;
	/** Absent means Claude, else the place's only CLI. */
	harness?: SessionHarness | typeof UNPICKED_WORD;
	resumeSessionId?: string;
	fresh?: true;
	sessionToken?: string;
	dedupKey?: string;
	launchId?: string;
}

/** What an older Gateway may still send. */
export type DaemonHostOp = HostOp | LegacyCreateSessionOp;

export type HostJsonValue = null | boolean | number | string | HostJsonValue[] | { [key: string]: HostJsonValue };
export type HostJsonObject = { [key: string]: HostJsonValue };

export interface HostClaudeRunOp {
	kind: "claudeRun";
	target: AgentExecutionTarget;
	runId: string;
	turnId: string;
	sessionId: string;
	resume: boolean;
	prompt: string;
	appendSystemPrompt: string | null;
	model?: string;
	effort?: string;
	jsonSchema?: HostJsonObject;
}

export interface HostClaudeCancelOp {
	kind: "claudeCancel";
	runId: string;
	turnId: string;
	target: AgentExecutionTarget;
}

export const HostKasaScanResultSchema = z.union([
	z.object({ candidates: z.array(DeviceCandidateSchema).max(DEVICE_MAX_RECORDS) }).strict(),
	z.object({ reason: z.enum(["no_interface", "socket"]) }).strict(),
]);

export type HostKasaScanResult = z.infer<typeof HostKasaScanResultSchema>;

export const HOST_BLE_SCAN_MAX_DEVICES = 256;

export const HostBleScanDeviceSchema = DeviceNearbySchema.omit({ radio: true }).extend({
	services: z.array(z.string().regex(/^[0-9a-f]{4}$/)).max(64),
});

export const HostBleScanResultSchema = z.union([
	z.object({ devices: z.array(HostBleScanDeviceSchema).max(HOST_BLE_SCAN_MAX_DEVICES) }).strict(),
	z.object({ reason: z.enum(["no_radio", "scan_failed"]) }).strict(),
]);

export type HostBleScanResult = z.infer<typeof HostBleScanResultSchema>;

/** The WiFi the host is on; `none` when it is on none or cannot tell. */
export const HostWifiNetworkResultSchema = z.union([
	z.object({ ssid: z.string().min(1).max(32) }).strict(),
	z.object({ reason: z.literal("none") }).strict(),
]);

export type HostWifiNetworkResult = z.infer<typeof HostWifiNetworkResultSchema>;

export interface HostListDirsResult {
	entries: string[];
	truncated?: boolean;
	path?: string;
}

export const HostReadSkillOpSchema = z
	.object({
		kind: z.literal("readSkill"),
		target: AgentExecutionTargetSchema,
		path: z.string().min(1).max(4096),
	})
	.strict();

export const HostReadSkillResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("read"), text: z.string() }).strict(),
	z
		.object({
			kind: z.literal("refused"),
			code: z.enum(["missing", "non_regular", "non_utf8", "too_large", "outside_target"]),
		})
		.strict(),
]);

export type HostReadSkillResult = z.infer<typeof HostReadSkillResultSchema>;

export const HostAgentModelsOpSchema = z
	.object({
		kind: z.literal("agentModels"),
		backend: z.enum(AGENT_BACKEND_IDS),
		target: AgentExecutionTargetSchema,
	})
	.strict();

export const HostAgentModelsResultSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("listed"), models: z.array(z.string().min(1).max(128)).max(2048) }).strict(),
	z.object({ kind: z.literal("refused"), reason: z.string().max(512) }).strict(),
]);

export type HostAgentModelsResult = z.infer<typeof HostAgentModelsResultSchema>;

const HostJsonValueSchema: z.ZodType<HostJsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(HostJsonValueSchema),
		z.record(z.string(), HostJsonValueSchema),
	]),
);

/** Filename-safe turn id. */
const ClaudeTurnIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Capped project instructions. */
const APPEND_SYSTEM_PROMPT_MAX = 64 * 1024;

export const HostClaudeRunOpSchema = z
	.object({
		kind: z.literal("claudeRun"),
		target: AgentExecutionTargetSchema,
		runId: z.string().min(1),
		turnId: ClaudeTurnIdSchema,
		sessionId: z.string().uuid(),
		resume: z.boolean(),
		prompt: z.string().max(AGENT_PROMPT_MAX_BYTES),
		appendSystemPrompt: z.string().max(APPEND_SYSTEM_PROMPT_MAX).nullable(),
		model: z.string().optional(),
		effort: z.string().optional(),
		jsonSchema: z.record(z.string(), HostJsonValueSchema).optional(),
	})
	.strict();

export const HostClaudeCancelOpSchema = z
	.object({
		kind: z.literal("claudeCancel"),
		runId: z.string().min(1),
		turnId: ClaudeTurnIdSchema,
		target: AgentExecutionTargetSchema,
	})
	.strict();

export const HostClaudeRunReplySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("accepted") }).strict(),
	z.object({ kind: z.literal("refused"), code: z.enum(["binaryMissing", "badTarget", "busy"]) }).strict(),
]);

export const HostClaudeCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();

export const ClaudeTurnResultFrameSchema = z
	.object({
		type: z.literal("claude_turn_result"),
		runId: z.string().min(1),
		turnId: z.string().min(1),
		sessionId: z.string().uuid(),
		outcome: z.enum(["completed", "failed", "cancelled", "sessionMissing"]),
		answer: HostJsonValueSchema.nullable(),
		reason: z.string().nullable(),
	})
	.strict();

export const ClaudeTurnAckFrameSchema = z
	.object({ type: z.literal("claude_turn_ack"), runId: z.string().min(1), turnId: z.string().min(1) })
	.strict();

export type HostClaudeRunReply = z.infer<typeof HostClaudeRunReplySchema>;
export type ClaudeTurnResultFrame = z.infer<typeof ClaudeTurnResultFrameSchema>;
export type ClaudeTurnAckFrame = z.infer<typeof ClaudeTurnAckFrameSchema>;

export interface TmuxPeek {
	ansi: string;
	hash: string;
}

/** One string per pane. */
export const paneKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

export type PromptDecision = "approve" | "deny";

export type TypeIntoPaneResult = { typed: true } | { typed: false; reason: "busy" };

/** Stale: the pane holds another prompt, or none. */
export type PromptOutcome = "answered" | "stale";

export type HostPeekResult =
	| { kind: "tmux"; ansi: string; hash: string }
	| { kind: "container-logs"; text: string; hash: string };

export type PeekErrorKind = "absent" | "failure";

const TmuxTargetSchema = z
	.object({
		kind: z.enum(["host", "devcontainer"]),
		name: z.string().refine(isTmuxName, "name must be a slug"),
		sessionName: z.string().refine(isTmuxName, "session name must be a slug"),
	})
	.strict();

/** Check ids at every filename build. */
export const ClaudeConversationIdSchema = z.string().uuid();

/** A retry deletes nothing more. The pane closes first to prevent writes. */
export const HostPurgeOpSchema = z
	.object({
		kind: z.literal("purge"),
		target: AgentExecutionTargetSchema,
		what: z.discriminatedUnion("kind", [
			// Drivers delete CLI threads.
			z
				.object({
					kind: z.literal("thread"),
					backend: z.enum(AGENT_BACKEND_IDS),
					threadId: z.string().min(1).max(256),
				})
				.strict(),
			// UUID becomes the filename.
			z.object({ kind: z.literal("claude"), conversationId: ClaudeConversationIdSchema }).strict(),
			z.object({ kind: z.literal("files"), session: TmuxTargetSchema }).strict(),
		]),
		pane: TmuxTargetSchema.optional(),
		/** Host spawn point whose home holds the data. Absent is the daemon's own. */
		hostSpawn: z.string().min(1).max(64).optional(),
	})
	.strict();

export type HostPurgeOp = z.infer<typeof HostPurgeOpSchema>;

/** `place_down`: its container or home is out of reach. A failure is the op's error. */
export const PURGE_OUTCOMES = ["deleted", "gone", "place_down"] as const;
export type PurgeOutcome = (typeof PURGE_OUTCOMES)[number];

export const HostPurgeResultSchema = z.object({ outcome: z.enum(PURGE_OUTCOMES) }).strict();

/** A thread a CLI's store holds. `updatedAt` is null when the store does not say. */
export const ListedThreadSchema = z
	.object({
		threadId: z.string().min(1).max(256),
		updatedAt: z.number().int().nonnegative().nullable(),
		/** The thread it was spawned under. */
		parentId: z.string().min(1).max(256).nullable(),
	})
	.strict();
export type ListedThread = z.infer<typeof ListedThreadSchema>;

/** The whole store at one place, never part of it. */
export const HostThreadsResultSchema = z.object({ threads: z.array(ListedThreadSchema) }).strict();

export interface HostOpResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	errorKind?: PeekErrorKind | "timeout" | "disconnected";
	/** Why a launch did not come up. */
	failure?: LaunchFailure;
}

const PEEK_ABSENT_PATTERNS = [
	"no server running",
	"can't find session",
	"can't find pane",
	"no such container",
	"is not running",
];
// Vanished panes mean absent.
export function classifyPeekError(error: string): PeekErrorKind {
	const lower = error.toLowerCase();
	if (lower.includes("timed out") || lower.includes("tmux command exited")) return "failure";
	if (PEEK_ABSENT_PATTERNS.some((s) => lower.includes(s))) return "absent";
	return "failure";
}
