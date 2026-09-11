import { z } from "zod";
import { CrossDomainPresenceSessionSchema } from "./federation-protocol.js";
import { ConnectionModeSchema, TeamKindSchema } from "./schemasCore.js";

////////////////////////////////
//  Team Info Schema
//
//  The per-team record on the /teams route and the presence planes. `status` is
//  the wire word verbatim; `kind` separates wakeable devcontainer projects from
//  ad-hoc loose sessions.

/** Discovery metadata, never a presence row: a row would make a machine's shell shareable. */
export const GatewaySpawnPointsSchema = z
	.object({
		domainId: z.string().min(1),
		gatewayId: z.string().min(1),
		// Host is implicit.
		hostSpawns: z.array(z.string().min(1).max(64)).max(8),
	})
	.meta({ id: "GatewaySpawnPoints" });

export const TeamInfoSchema = z
	.object({
		team: z.string(),
		// Router-stamped row identity.
		gatewayId: z.string().min(1),
		domainId: z.string().min(1),
		// Status reflects incarnation.
		status: z.enum(["online", "verifying", "available"]),
		mode: ConnectionModeSchema.optional(),
		// Gateway-stamped team kind.
		kind: TeamKindSchema,
		// Board session label.
		sessionLabel: z.string().optional(),
		// Inbound compatibility field.
		description: z.string().optional(),
		// The plugin version the agent's MCP process reported at register. Absent for
		// consoles and offline-catalog entries (no plugin process behind them). The console
		// shows it as a chip only when it differs from the app's own expected version.
		version: z.string().optional(),
		// Epoch ms a session was last seen (from the session-resume map). Stamped for
		// sessions the gateway has a resume entry for, so the console can order the list and
		// show recency ("active 5m ago"). Absent for sessions with no resume record.
		lastActive: z.number().int().optional(),
		queue_depth: z.number().int().nonnegative(),
		// Daemon-derived from the session's own tmux pane (2-frame-hysteresis confirmed). Absent
		// means UNKNOWN (never observed, or derivation just became impossible - daemon disconnect,
		// a peek-failure streak, or the session going asleep), never false: a tile shows no pulse
		// rather than a stale frozen one. Only tmux-backed live sessions ever carry a value.
		working: z.boolean().optional(),
		needsLogin: z.boolean().optional(),
		// The session is holding an unanswered usage-limit dialog, so it cannot progress until the
		// choice is answered. limitDetail is the text after the headline's middle dot ("resets 5pm"),
		// absent when that headline carried no dot. Two flat fields rather than one, because a blocked
		// session with no reset text still has to render as blocked.
		limitBlocked: z.boolean().optional(),
		limitDetail: z.string().optional(),
		// Same-Domain federation freshness for a PEER-gateway-sourced row (this gateway's own local
		// rows never carry it - absent, not a fourth "local" value). "unreachable" is the honest
		// stale-mark Q4 requires; "quiet" is healthy idle, not stale.
		presenceFresh: z.enum(["fresh", "quiet", "unreachable"]).optional(),
	})
	.meta({ id: "TeamInfo" });

/** One source gateway's presence-plane version, as carried on the wire: an array of these (never
 * a map - codegen has no typed map, only an untyped JsonObject fallback outside the fixture
 * gates). `gateway` is the source gateway's id; today the array holds exactly one entry, this
 * gateway's own, until cross-Gateway presence exchange is implemented. */
export const PresenceVersionSchema = z
	.object({
		gateway: z.string(),
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "PresenceVersion" });

/** What the phone is currently looking at, declared on every poll so it survives a reconnect with
 * no separate op. Absent/omitted degrades to "background" once the prior declaration's TTL lapses
 * (a killed app needs no goodbye) - see gateway/intent.ts's IntentTracker, the server-side owner of
 * that TTL. */
export const FocusIntentSchema = z
	.object({
		screen: z.enum(["board", "terminal", "background"]),
		// Required when screen is "terminal": which session's terminal is open.
		terminalTeam: z.string().optional(),
		// The phone's configured terminal refresh rate; only meaningful with terminalTeam set.
		terminalRateMs: z.number().int().positive().optional(),
	})
	.meta({ id: "FocusIntent" });

/** A registry plane's version, for a plane with no multi-source concept (unlike presence's
 * per-source-gateway array - this Gateway's linked-peers roster is ALWAYS this Gateway's own
 * single view, never relayed from a peer). Same {epoch, counter} shape PlaneRegistry.version
 * returns internally, just named per-plane on the wire so a client presents the right one back. */
export const LinkedPeersVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "LinkedPeersVersion" });

// One peer row in a list_peers result: a linked friend Domain projected from the gateway's
// cross-Domain peer set. A Domain may run more than one gateway, so the same domainId can repeat
// once per gateway; the console groups by domainId. Named (.meta id) so the codegen emits it as a
// Kotlin nested class instead of erroring on an inline array-of-object. Defined ahead of
// ConsoleOpSchema/ConsolePollResultSchema (not just its own cross_domain_list_peers result) since
// the poll response's linked-peers piggyback (below) references it too.
export const CrossDomainPeerEntrySchema = z
	.object({
		domainId: z.string(),
		gatewayId: z.string(),
		// The friend OWNER's signing key (base64) - the owner-keyed identity the Users surface joins on
		// (a roster row is keyed by owner, so this maps a linked Domain back to the person who owns it).
		ownerSignPub: z.string(),
	})
	.meta({ id: "CrossDomainPeerEntry" });

/** Same scalar shape as LinkedPeersVersion - a read-anchors plane is PER OWNER (never a single
 * Gateway-wide plane; see readAnchors.ts's own doc on why), but each owner's own plane still has
 * no multi-source concept of its own, so one scalar version covers it. */
export const ReadAnchorsVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorsVersion" });

/** The task-board plane's version, one scalar per owner - same shape and reasoning as
 * ReadAnchorsVersion above (per-owner plane, no multi-source concept). */
export const TaskBoardVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "TaskBoardVersion" });

/** One linked Domain's presence version; each linked Domain has its own. */
export const CrossDomainPresenceVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainPresenceVersion" });

/** Domain-keyed friend presence. */
export const CrossDomainPresenceEntrySchema = z
	.object({
		domainId: z.string(),
		// Friend Domain label.
		displayName: z.string().nullable(),
		version: CrossDomainPresenceVersionSchema,
		sessions: z.array(CrossDomainPresenceSessionSchema),
		lastRefreshedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainPresenceEntry" });

/** One team's synced read position: the furthest any of this owner's OWN devices has confirmed
 * reading, merged monotonically server-side (see ReadAnchors.report - never regresses). `epoch`/
 * `seq` are the SAME mailbox journal coordinate the app's own local ReadAnchor already uses
 * (device-mailbox.ts) - meaningful across an owner's whole device fleet because the mailbox itself
 * is already shared per owner, not per device. An array (never a map - codegen has no typed map
 * outside the fixture gates), one entry per team that has ever been reported. */
export const ReadAnchorWireEntrySchema = z
	.object({
		team: z.string(),
		epoch: z.number().int(),
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorWireEntry" });
