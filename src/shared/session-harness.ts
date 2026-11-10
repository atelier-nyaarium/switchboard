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

export interface HarnessRow {
	/** The phone's name for it. */
	readonly label: string;
	/** argv[0] under bash and under PowerShell. */
	readonly binary: { readonly posix: string; readonly windows: string };
	readonly containers: boolean;
	readonly assistant: boolean;
	/** The Gateway mints its session id. */
	readonly mintsSessionId: boolean;
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

export const HARNESS: Readonly<Record<SessionHarness, HarnessRow>> = {
	claude: {
		label: "Claude",
		binary: { posix: "claude", windows: "claude.exe" },
		containers: true,
		assistant: true,
		mintsSessionId: false,
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
		mintsSessionId: true,
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

// FIXME 2026-11-23: an absent one answers null too, once every sender names it.
/** Absent means Claude. Null for an unknown word. */
export function knownHarness(value: unknown): SessionHarness | null {
	if (value === undefined || value === null) return "claude";
	return isSessionHarness(value) ? value : null;
}

/** As `knownHarness`, throwing on an unknown word. */
export function wireHarness(value: unknown): SessionHarness {
	const harness = knownHarness(value);
	if (harness) return harness;
	throw new Error(`unknown session CLI "${String(value).slice(0, 32)}": this build is older than its sender`);
}

/** A hook hands a CLI its own baseline; otherwise the Gateway pushes it. */
const BASELINE_PUSHED: Record<HarnessRow["compaction"], boolean> = { hook: false, "copilot-events": true };

export function pushesBaseline(harness: SessionHarness): boolean {
	return BASELINE_PUSHED[HARNESS[harness].compaction];
}

/** Null for a CLI that is not a session harness. */
export function harnessRow(agentType: string): HarnessRow | null {
	return isSessionHarness(agentType) ? HARNESS[agentType] : null;
}
