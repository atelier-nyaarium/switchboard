// Session CLIs and their differences.

////////////////////////////////
//  Interfaces & Types

export const SESSION_HARNESSES = ["claude", "copilot"] as const;
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

export interface HarnessRow {
	/** The phone's name for it. */
	readonly label: string;
	/** argv[0] under bash and under PowerShell. */
	readonly binary: { readonly posix: string; readonly windows: string };
	readonly containers: boolean;
	readonly assistant: boolean;
	/** `shape` guards the command line. */
	readonly sessionId: SessionIdPolicy;
	/** Answers the registration handshake. */
	readonly handshake: boolean;
	/** How a pushed message enters. */
	readonly delivery: "channel" | "typed";
	/** Where its state is read, and how a launch is known ready. */
	readonly state: "pane";
	/** How a compaction is seen. */
	readonly compaction: "hook" | "copilot-events";
	readonly autoAnswers: readonly PaneAutoAnswer[];
	/** Claude's slash commands and plugin UI. */
	readonly claudeSlashTools: boolean;
	readonly workflowTools: boolean;
	/** Where capability guidance reaches the model. */
	readonly guidance: "handshake" | "instructions";
	readonly slashPalette: readonly SlashMacro[];
	/** Typed into a bare shell. */
	readonly shellMacros: readonly ShellMacro[];
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
		delivery: "channel",
		state: "pane",
		compaction: "hook",
		autoAnswers: ["limit"],
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
		delivery: "typed",
		state: "pane",
		compaction: "copilot-events",
		autoAnswers: ["survey"],
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

export function launchRefusal(harness: SessionHarness, at: { host: boolean; assistant: boolean }): string | null {
	const row = HARNESS[harness];
	if (!at.host && !row.containers) return `${row.label} runs only on a host spawn point`;
	if (at.assistant && !row.assistant) return `${row.label} never runs as the assistant`;
	return null;
}

/** A hook hands a CLI its own baseline; otherwise the Gateway pushes it. */
const BASELINE_PUSHED: Record<HarnessRow["compaction"], boolean> = { hook: false, "copilot-events": true };

export function pushesBaseline(harness: SessionHarness): boolean {
	return BASELINE_PUSHED[HARNESS[harness].compaction];
}

/** A resume id safe on that CLI's command line, or undefined. */
export function resumableId(harness: SessionHarness, id: string | undefined): string | undefined {
	return id !== undefined && HARNESS[harness].sessionId.shape.test(id) ? id : undefined;
}
