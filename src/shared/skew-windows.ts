////////////////////////////////
//  Skew windows
//
//  A skew window keeps a reader tolerant of an older writer while every part updates. Each row
//  names who still writes the old shape (`from`), where the tolerance lives (`in`), the date it
//  closes and what closing does. Every site carries `skew:<id>` in a comment, and
//  `skew-window-residue.test.ts` fails on a dated comment with no tag, a tag with no row, a row
//  with no site, and a row past its date: close it, or give it a new date and say why.

export type Part = "phone" | "plugin" | "gateway" | "daemon" | "router";

export interface SkewWindow {
	/** YYYY-MM-DD. */
	closes: string;
	/** Older builds that still write the old shape. */
	from: readonly Part[];
	/** Where the tolerance lives. */
	in: readonly Part[];
	/** What closing does. */
	ends: string;
	/** Why a passed date moved. */
	moved?: string;
}

/** The owner's phone, ql and matrix-edward are on builds this host cannot read. */
const UNSEEN = "a writer's build could not be read when its date passed";

export const SKEW_WINDOWS = {
	"harness-unnamed": {
		closes: "2026-12-10",
		from: ["phone", "plugin", "daemon"],
		in: ["gateway", "phone"],
		ends: "Delete `unnamed`; every sender names its CLI.",
		moved: UNSEEN,
	},
	"console-op-harness": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["gateway"],
		ends: "A create's `harness` becomes required.",
		moved: UNSEEN,
	},
	"register-harness": {
		closes: "2026-12-10",
		from: ["plugin"],
		in: ["gateway"],
		ends: "A register's `harness` becomes required.",
		moved: UNSEEN,
	},
	"presence-harness": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["phone", "router"],
		ends: "A presence row's `harness` becomes required.",
		moved: UNSEEN,
	},
	"harness-spawns": {
		closes: "2026-12-10",
		from: ["daemon"],
		in: ["gateway", "phone"],
		ends: "Drop the per-CLI spawn lists; every reader takes `harnessSpawns`.",
		moved: UNSEEN,
	},
	"federation-harness": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["router", "phone"],
		ends: "A federated row's `harness` becomes required.",
		moved: UNSEEN,
	},
	"create-by-wake": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["daemon"],
		ends: "Drop the daemon's `createSession` op.",
		moved: UNSEEN,
	},
	"wake-launch-id": {
		closes: "2026-12-10",
		from: ["daemon", "gateway"],
		in: ["gateway", "daemon"],
		ends: "`launchId` becomes required on every wake frame.",
		moved: "the host daemons still run a build from before it",
	},
	"agent-list-detail": {
		closes: "2026-12-10",
		from: ["plugin"],
		in: ["gateway"],
		ends: "Drop `detail` from an agent list; the input is strict, so an older plugin is refused.",
		moved: UNSEEN,
	},
	"reply-reader": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["gateway"],
		ends: "A held job's `reader` becomes required.",
		moved: UNSEEN,
	},
	"minted-session-id": {
		closes: "2026-12-10",
		from: ["gateway", "daemon"],
		in: ["gateway", "daemon"],
		ends: "Drop the `copilotSessionId` twin of `mintedSessionId`.",
		moved: "the host daemons still run a build from before it",
	},
	"routine-zone": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["gateway"],
		ends: "Drop the routine list's legacy zone.",
		moved: UNSEEN,
	},
	"routine-kind": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["gateway"],
		ends: "A routine target's `kind` becomes required.",
		moved: UNSEEN,
	},
	"home-integrations": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["gateway", "router"],
		ends: "A carried home's `integrations` becomes required.",
		moved: UNSEEN,
	},
	"assistant-state-catalogue": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["phone"],
		ends: "The assistant state's `integrations` and `offered` become required.",
		moved: UNSEEN,
	},
	"launch-record-id": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["gateway"],
		ends: "A launch record's `launchId` becomes required.",
		moved: "no read of the stored records was made",
	},
	"agent-socket-replace": {
		closes: "2026-12-10",
		from: ["plugin"],
		in: ["gateway"],
		ends: "A plugin naming its agent no longer replaces one that names none.",
		moved: UNSEEN,
	},
	"create-names-cli": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["gateway"],
		ends: "A wake from the phone names the row's CLI; drop the fallback.",
		moved: UNSEEN,
	},
	"gateway-old-lists": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["phone"],
		ends: "Drop the phone's reads of both old lists.",
		moved: UNSEEN,
	},
	"draft-flat-layout": {
		closes: "2026-12-10",
		from: ["phone"],
		in: ["phone"],
		ends: "Drop the flat draft layout: its read in `load`, its delete in `clear`, and every `*.draft` left in `dir`.",
		moved: UNSEEN,
	},
	"watchers-field": {
		closes: "2026-11-28",
		from: ["phone", "gateway"],
		in: ["gateway", "phone"],
		ends: "Drop `watchers` and its schema from the assistant state; `sources` becomes required.",
	},
	"assistant-temperature-unit": {
		closes: "2026-11-28",
		from: ["gateway"],
		in: ["phone"],
		ends: "The assistant state's `temperatureUnit` becomes required.",
	},
	"home-temperature-unit": {
		closes: "2026-11-27",
		from: ["phone"],
		in: ["gateway", "router"],
		ends: "A carried home's `temperatureUnit` becomes required.",
	},
	"devices-required": {
		closes: "2026-11-28",
		from: ["gateway"],
		in: ["phone", "plugin"],
		ends: "The device fields marked with it become required.",
	},
	"stored-rules": {
		closes: "2026-11-28",
		from: ["phone", "gateway"],
		in: ["gateway", "phone"],
		ends: "Drop the stored watcher rules, their adoption and the rule ops; delete `assistant-rules.json` and its mark.",
	},
	"watcher-kinds": {
		closes: "2026-11-28",
		from: ["phone", "gateway"],
		in: ["gateway", "phone"],
		ends: "Drop the `assistant_watcher_*` op kinds.",
	},
	"action-family-word": {
		closes: "2026-11-28",
		from: ["plugin", "gateway"],
		in: ["gateway", "plugin"],
		ends: "Drop the `watcher` family word for `source`.",
	},
	"inbox-decision-word": {
		closes: "2026-11-28",
		from: ["gateway"],
		in: ["plugin"],
		ends: "Drop the `wake` and `inbox` decision words for `tell`.",
	},
	"vault-watcher-grants": {
		closes: "2026-11-28",
		from: ["gateway", "phone"],
		in: ["gateway", "phone"],
		ends: "Drop the `watcher` grant word and its stored rows for services.",
	},
	"vault-required": {
		closes: "2026-12-03",
		from: ["gateway"],
		in: ["phone"],
		ends: "The vault field marked with it becomes required.",
	},
	"baseline-sources": {
		closes: "2026-11-28",
		from: ["gateway"],
		in: ["plugin"],
		ends: "The baseline reads `sources` alone.",
	},
	"untyped-trigger": {
		closes: "2026-11-28",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the read of an automation body stored before triggers had kinds.",
	},
	"sources-changed": {
		closes: "2026-11-28",
		from: ["phone"],
		in: ["gateway"],
		ends: "The Gateway's change word becomes `sources-changed`.",
	},
	"assistant-plugin-word": {
		closes: "2026-12-12",
		from: ["gateway"],
		in: ["phone"],
		ends: "Drop the change word from before `sources-changed`.",
	},
	"session-store-legacy": {
		closes: "2026-12-11",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the session store's legacy reads.",
	},
	"automation-serves": {
		closes: "2026-11-29",
		from: ["gateway"],
		in: ["phone"],
		ends: "Every listing names what it serves; drop the prose refusal and the legacy offer.",
	},
	"function-row-callers": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["phone"],
		ends: "A function row's `callers` becomes required.",
	},
	"function-serves": {
		closes: "2026-12-10",
		from: ["gateway"],
		in: ["phone"],
		ends: "`serves.functions` names its statements, `unnamed` and `script`, all required.",
	},
	"fire-tell": {
		closes: "2026-12-16",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the one `tell` a fire stored for its whole run.",
	},
	"fire-84-shape": {
		closes: "2026-12-16",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the read of a fire stored by 8.14.84.",
	},
	"frame-values": {
		closes: "2026-12-16",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the frame that reads its pointer's values.",
	},
	"stored-thresholds": {
		closes: "2027-01-15",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the sensor threshold conversion and its files.",
	},
	"checkpoint-run-time": {
		closes: "2027-01-15",
		from: ["gateway"],
		in: ["gateway"],
		ends: "Drop the run time kept on a checkpoint alone.",
	},
} as const satisfies Record<string, SkewWindow>;

export type SkewWindowId = keyof typeof SKEW_WINDOWS;
