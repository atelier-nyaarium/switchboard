// Session CLIs and their differences.

////////////////////////////////
//  Interfaces & Types

/** In offer order. */
export const SESSION_HARNESSES = ["claude", "opencode", "copilot"] as const;
export type SessionHarness = (typeof SESSION_HARNESSES)[number];

/** Pane dialogs the daemon answers itself. */
export type PaneAutoAnswer = "limit" | "survey";

export interface SlashMacro {
	cmd: string;
	/** False stages it for more typing. */
	autoSend: boolean;
}

export interface ShellMacro {
	label: string;
	cmd: string;
}

/** Who names a session's id, and what one looks like. */
export type SessionIdPolicy =
	| { readonly minted: false; readonly shape: RegExp }
	| { readonly minted: true; readonly shape: RegExp; mint(uuid: () => string): string };

/** A CLI word as it arrived, read once. */
export type HarnessWord =
	| { readonly read: "named"; readonly harness: SessionHarness }
	// FIXME 2026-11-23: delete `unnamed`, once every sender names its CLI.
	| { readonly read: "unnamed"; readonly assumed: SessionHarness }
	| { readonly read: "unknown"; readonly word: string };

/** Read and driven through its pane, by the daemon. */
export interface PaneRoad {
	readonly kind: "pane";
	/** How a pushed message enters. */
	readonly delivery: "channel" | "typed";
	/** How a compaction is seen. */
	readonly compaction: "screen" | "copilot-events";
	readonly autoAnswers: readonly PaneAutoAnswer[];
}

/** Read and driven through its own local server, by the plugin. */
export interface ApiRoad {
	readonly kind: "api";
	/** Which server's client and launcher. */
	readonly server: "opencode";
}

/** One rule of a CLI's own permission engine. */
export interface PermissionRule {
	readonly action: string;
	readonly resource: string;
	readonly effect: "allow" | "deny" | "ask";
}

export interface HarnessRow {
	/** The phone's name for it. */
	readonly label: string;
	readonly binary: {
		/** argv[0] under bash. */
		readonly posix: string;
		/** argv[0] under PowerShell. Null never launches there. */
		readonly windows: string | null;
		/** Its installer's directory under home, searched after PATH. */
		readonly homeDir?: string;
	};
	readonly containers: boolean;
	readonly assistant: boolean;
	/** `shape` guards the command line. */
	readonly sessionId: SessionIdPolicy;
	/** Answers the registration handshake. */
	readonly handshake: boolean;
	/** How its state is read and its messages enter. */
	readonly road: PaneRoad | ApiRoad;
	/** Who fetches a compacted session's baseline: the session itself, or the Gateway on its edge. */
	readonly baseline: "session" | "gateway";
	/** Exact versions a launch accepts. Absent accepts any. */
	readonly versions?: readonly string[];
	/** Claude's slash commands and plugin UI. */
	readonly claudeSlashTools: boolean;
	readonly workflowTools: boolean;
	/** Where capability guidance reaches the model. */
	readonly guidance: "handshake" | "instructions";
	readonly slashPalette: readonly SlashMacro[];
	/** Typed into a bare shell. */
	readonly shellMacros: readonly ShellMacro[];
	/** Keys that end the app, never sent. */
	readonly refusedKeys: readonly string[];
	/** Takes a typed `/goal` line. */
	readonly goals: boolean;
	/** Laid over the CLI's own policy at create. */
	readonly permissions: readonly PermissionRule[];
}

////////////////////////////////
//  Constants

const CLAUDE_SLASH: readonly SlashMacro[] = [
	{ cmd: "/btw", autoSend: false },
	{ cmd: "/model", autoSend: true },
	{ cmd: "/effort", autoSend: true },
	{ cmd: "/usage", autoSend: true },
	{ cmd: "/context", autoSend: true },
	{ cmd: "/workflows", autoSend: true },
	{ cmd: "/resume", autoSend: true },
	{ cmd: "/compact", autoSend: false },
	{ cmd: "/mcp", autoSend: true },
	{ cmd: "/plugin", autoSend: true },
	{ cmd: "/reload-plugins", autoSend: true },
];

const PLUGINS = "switchboard nyaaskills lexicon";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one accepted OpenCode release. */
export const OPENCODE_PIN = "2.2.5";

/** A fresh session's first words. */
export const FIRST_LAUNCH_GREETING = `welcome, see your switchboard capabilities`;

/** What a sender that named no CLI ran. */
export const UNNAMED_HARNESS: SessionHarness = "claude";

export const HARNESS: Readonly<Record<SessionHarness, HarnessRow>> = {
	claude: {
		label: "Claude",
		binary: { posix: "claude", windows: "claude.exe" },
		containers: true,
		assistant: true,
		sessionId: { minted: false, shape: /^[0-9a-fA-F-]{8,}$/ },
		handshake: true,
		road: { kind: "pane", delivery: "channel", compaction: "screen", autoAnswers: ["limit"] },
		baseline: "session",
		claudeSlashTools: true,
		workflowTools: true,
		guidance: "handshake",
		slashPalette: CLAUDE_SLASH,
		shellMacros: [
			{ label: "Install Claude", cmd: "curl -fsSL https://claude.ai/install.sh | bash" },
			{
				label: "Claude Tools",
				cmd: `claude plugin marketplace add atelier-nyaarium/claude-marketplace || claude plugin marketplace update atelier-nyaarium; for p in ${PLUGINS}; do claude plugin install $p@atelier-nyaarium && claude plugin update -y $p@atelier-nyaarium; done`,
			},
		],
		refusedKeys: [],
		goals: true,
		permissions: [],
	},
	opencode: {
		label: "OpenCode",
		binary: { posix: "opencode", windows: null, homeDir: ".opencode/bin" },
		// Host only.
		containers: false,
		assistant: false,
		// The id names the session before it exists.
		sessionId: {
			minted: true,
			shape: /^ses_sb[0-9a-f]{32}$/,
			mint: (uuid) => `ses_sb${uuid().replace(/-/g, "")}`,
		},
		handshake: false,
		road: { kind: "api", server: "opencode" },
		baseline: "session",
		versions: [OPENCODE_PIN],
		claudeSlashTools: false,
		workflowTools: true,
		guidance: "instructions",
		slashPalette: [
			{ cmd: "/models", autoSend: true },
			{ cmd: "/variants", autoSend: true },
			{ cmd: "/usage", autoSend: true },
			{ cmd: "/status", autoSend: true },
			{ cmd: "/mcps", autoSend: true },
			{ cmd: "/compact", autoSend: true },
		],
		shellMacros: [
			{
				label: "Install OpenCode",
				cmd: `curl -fsSL https://opencode.ai/v2/install | bash -s -- --version ${OPENCODE_PIN}`,
			},
			{ label: "OpenCode Sign-in", cmd: "opencode auth login" },
		],
		// An empty composer exits on it.
		refusedKeys: ["C-c"],
		goals: false,
		permissions: [],
	},
	copilot: {
		label: "Copilot",
		// VS Code's shim resolves `copilot.exe`.
		binary: { posix: "copilot", windows: "copilot.exe" },
		containers: false,
		assistant: false,
		// The id names the session before it exists.
		sessionId: { minted: true, shape: UUID, mint: (uuid) => uuid() },
		handshake: false,
		road: { kind: "pane", delivery: "typed", compaction: "copilot-events", autoAnswers: ["survey"] },
		baseline: "gateway",
		claudeSlashTools: false,
		workflowTools: true,
		guidance: "instructions",
		slashPalette: CLAUDE_SLASH,
		// Copilot never updates its own plugin copies.
		shellMacros: [
			{ label: "Install Copilot", cmd: "curl -fsSL https://gh.io/copilot-install | bash" },
			{
				label: "Copilot Tools",
				cmd: `copilot plugin marketplace add atelier-nyaarium/claude-marketplace; copilot plugin marketplace update; for p in ${PLUGINS}; do copilot plugin install $p@atelier-nyaarium; copilot plugin update $p@atelier-nyaarium; done`,
			},
		],
		refusedKeys: [],
		goals: true,
		permissions: [],
	},
};

////////////////////////////////
//  Functions & Helpers

export function isSessionHarness(value: unknown): value is SessionHarness {
	return typeof value === "string" && (SESSION_HARNESSES as readonly string[]).includes(value);
}

/** The one reading of a CLI word off a wire or a file. */
export function readHarness(value: unknown): HarnessWord {
	if (value === undefined || value === null) return { read: "unnamed", assumed: UNNAMED_HARNESS };
	if (isSessionHarness(value)) return { read: "named", harness: value };
	return { read: "unknown", word: String(value) };
}

/** Each reader states all three cases. */
export function foldHarness<T>(
	word: HarnessWord,
	on: { named(harness: SessionHarness): T; unnamed(assumed: SessionHarness): T; unknown(word: string): T },
): T {
	switch (word.read) {
		case "named":
			return on.named(word.harness);
		case "unnamed":
			return on.unnamed(word.assumed);
		case "unknown":
			return on.unknown(word.word);
	}
}

/** The refusal for a word a newer sender named. */
export function olderThanSender(word: string): string {
	return `unknown session CLI "${word.slice(0, 32)}": this build is older than its sender`;
}

export function mintedIdOf(harness: SessionHarness, value: unknown): string | undefined {
	const policy = HARNESS[harness].sessionId;
	return policy.minted && typeof value === "string" && policy.shape.test(value) ? value : undefined;
}

/** Which shell a launch lands in. */
export type LaunchPlace = "host" | "windows" | "container";

export function launchRefusal(harness: SessionHarness, at: { place: LaunchPlace; assistant: boolean }): string | null {
	const row = HARNESS[harness];
	if (at.place === "container" && !row.containers) return `${row.label} runs only on a host spawn point`;
	// A launcher never crosses to PowerShell.
	if (at.place === "windows" && (row.binary.windows === null || row.road.kind === "api")) {
		return `${row.label} does not run on a Windows shell`;
	}
	if (at.assistant && !row.assistant) return `${row.label} never runs as the assistant`;
	return null;
}

/** The pane road of a CLI the daemon reads, or undefined. */
export function paneRoad(harness: SessionHarness): PaneRoad | undefined {
	const { road } = HARNESS[harness];
	return road.kind === "pane" ? road : undefined;
}

/** A hook hands a CLI its own baseline; otherwise the Gateway pushes it. */
export function pushesBaseline(harness: SessionHarness): boolean {
	return HARNESS[harness].baseline === "gateway";
}

export type SessionDelivery = PaneRoad["delivery"] | "api";

export function deliveryOf(harness: SessionHarness): SessionDelivery {
	const { road } = HARNESS[harness];
	return road.kind === "pane" ? road.delivery : "api";
}

/** Its plugin reports its state; no pane reader runs. */
export function readsOwnState(harness: SessionHarness): boolean {
	return HARNESS[harness].road.kind === "api";
}

export function typesDelivery(harness: SessionHarness): boolean {
	return paneRoad(harness)?.delivery === "typed";
}

/** Why a launch refuses this version, or null. */
export function versionRefusal(harness: SessionHarness, version: string | undefined): string | null {
	const row = HARNESS[harness];
	if (!row.versions) return null;
	if (version === undefined) return `${row.label} did not report its version`;
	if (row.versions.includes(version)) return null;
	return `${row.label} ${version} is outside the supported range (${row.versions.join(", ")})`;
}

/** A resume id safe on that CLI's command line, or undefined. */
export function resumableId(harness: SessionHarness, id: string | undefined): string | undefined {
	return id !== undefined && HARNESS[harness].sessionId.shape.test(id) ? id : undefined;
}
