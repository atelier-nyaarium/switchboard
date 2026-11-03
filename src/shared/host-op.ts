import { z } from "zod";
import { WINDOWS_SPAWN } from "./host-spawn.js";
import { DEVICE_MAX_RECORDS, DeviceCandidateSchema } from "./schemasDevices.js";

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

export const TMUX_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_TMUX_NAME_LEN = 64;
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

export const SHELL_SAFE_NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;
// Rejects shell metacharacters.
export function isShellSafeName(name: string): boolean {
	return name.length <= MAX_TMUX_NAME_LEN && SHELL_SAFE_NAME_RE.test(name);
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

export const CONVERSATION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_CONVERSATION_ID_LEN = 128;

export type HostOp =
	| { kind: "peek"; target: TmuxTarget }
	| { kind: "kasaScan" }
	| { kind: "wifiNetwork" }
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
	| {
			kind: "createSession";
			target: TmuxTarget;
			workdirHint?: string;
			resumeSessionId?: string;
			sessionToken?: string;
			dedupKey?: string;
	  }
	| { kind: "listDirs"; path: string; spawn?: string }
	| { kind: "reloadPlugins"; target: TmuxTarget; dedupKey?: string }
	| { kind: "killSession"; target: TmuxTarget; dedupKey?: string };

export const HostKasaScanResultSchema = z.union([
	z.object({ candidates: z.array(DeviceCandidateSchema).max(DEVICE_MAX_RECORDS) }).strict(),
	z.object({ reason: z.enum(["no_interface", "socket"]) }).strict(),
]);

export type HostKasaScanResult = z.infer<typeof HostKasaScanResultSchema>;

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

export interface TmuxPeek {
	ansi: string;
	hash: string;
}

/** One string per pane. */
export const paneKey = (t: TmuxTarget): string => `${t.kind}:${t.name}:${t.sessionName}`;

export type PromptDecision = "approve" | "deny";

/** Stale: the pane holds another prompt, or none. */
export type PromptOutcome = "answered" | "stale";

export type HostPeekResult =
	| { kind: "tmux"; ansi: string; hash: string }
	| { kind: "container-logs"; text: string; hash: string };

export type PeekErrorKind = "absent" | "failure";

export interface HostOpResult {
	ok: boolean;
	result?: unknown;
	error?: string;
	errorKind?: PeekErrorKind | "timeout" | "disconnected";
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
