import { z } from "zod";
import { CrossDomainPresenceSessionSchema } from "./federation-protocol.js";
import { ConnectionModeSchema, TeamKindSchema } from "./schemasCore.js";
import { SESSION_HARNESSES, type SessionHarness } from "./session-harness.js";
import { ASSISTANT_ROLE } from "./wire-vocabulary.js";

////////////////////////////////
//  Team Info Schema
//
//  The per-team record on the /teams route and the presence planes. `status` is
//  the wire word verbatim; `kind` separates wakeable devcontainer projects from
//  ad-hoc loose sessions.

const SpawnListSchema = z.array(z.string().min(1).max(64)).max(9).optional();

/** Per CLI, spawn points with it. A property each, so readers skip unknown CLIs. */
export const HarnessSpawnsSchema = z
	.object(
		Object.fromEntries(SESSION_HARNESSES.map((harness) => [harness, SpawnListSchema])) as Record<
			SessionHarness,
			typeof SpawnListSchema
		>,
	)
	.meta({ id: "HarnessSpawns" });

export const CONTAINER_STATES = ["stopped", "starting", "running"] as const;

/** A dev container as docker reports it, and the CLIs found inside. */
export const ContainerStateSchema = z
	.object({
		project: z.string().min(1).max(64),
		state: z.enum(CONTAINER_STATES),
		/** The last Start or Stop that failed, until the next one. */
		failure: z.string().max(512).optional(),
		/** Absent until looked inside; empty when none is installed. */
		clis: z.array(z.enum(SESSION_HARNESSES)).max(SESSION_HARNESSES.length).optional(),
	})
	.meta({ id: "ContainerState" });

export type ContainerState = z.infer<typeof ContainerStateSchema>;

export const ContainerListSchema = z.array(ContainerStateSchema).max(128);

/** Discovery metadata, never a presence row: a row would make a machine's shell shareable. */
export const GatewaySpawnPointsSchema = z
	.object({
		domainId: z.string().min(1),
		gatewayId: z.string().min(1),
		// Host is implicit.
		hostSpawns: z.array(z.string().min(1).max(64)).max(8),
		// FIXME 2026-11-23: required, once every Gateway sends it.
		harnessSpawns: HarnessSpawnsSchema.optional(),
		// FIXME 2026-11-23: drop both, once every reader takes `harnessSpawns`.
		claudeSpawns: SpawnListSchema,
		copilotSpawns: SpawnListSchema,
		containers: ContainerListSchema.optional(),
	})
	.meta({ id: "GatewaySpawnPoints" });

/** A permission prompt a session is holding. */
export const SessionPromptSchema = z
	.object({
		id: z.string().min(1).max(64),
		title: z.string().max(512),
		body: z.array(z.string().max(512)).max(80),
	})
	.meta({ id: "SessionPrompt" });

export type SessionPrompt = z.infer<typeof SessionPromptSchema>;

/** What the daemon derives from a session's pane: the `presence_derive` frame. */
export const DerivedPresenceSchema = z.object({
	working: z.boolean(),
	needsLogin: z.boolean(),
	// An unanswered usage-limit dialog.
	limitBlocked: z.boolean(),
	// Limit reset text.
	limitDetail: z.string().optional(),
	prompt: SessionPromptSchema.optional(),
	// Set only while one runs.
	workflow: z.boolean().optional(),
	// Set only while one works.
	teammates: z.boolean().optional(),
	// Set only while it runs.
	compacting: z.boolean().optional(),
});

export type DerivedPresence = z.infer<typeof DerivedPresenceSchema>;

/** The row's view of a derived state: every field absent until observed, the prompt as its id. */
const ProjectedPresenceSchema = DerivedPresenceSchema.omit({ prompt: true })
	.partial()
	.extend({
		// Its text is sealed.
		promptId: z.string().max(64).optional(),
	});

export type ProjectedPresence = z.infer<typeof ProjectedPresenceSchema>;

export function projectDerived(derived: DerivedPresence): ProjectedPresence {
	const { prompt, ...rest } = derived;
	return { ...rest, ...(prompt ? { promptId: prompt.id } : {}) };
}

/** Every derived field, the prompt by id. */
export function sameDerived(a: DerivedPresence, b: DerivedPresence): boolean {
	for (const key of Object.keys(DerivedPresenceSchema.shape) as (keyof DerivedPresence)[]) {
		if (key === "prompt") {
			if (a.prompt?.id !== b.prompt?.id) return false;
		} else if (a[key] !== b[key]) return false;
	}
	return true;
}

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
		/** The session's CLI. A string, so readers skip unknown ones. */
		harness: z.string().min(1).max(32).optional(),
		// Gateway-stamped. The assistant's session lives in its own tab, never the Sessions list.
		role: z.enum([ASSISTANT_ROLE]).optional(),
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
		// Absent means unknown, never false.
		...ProjectedPresenceSchema.shape,
		// Same-Domain federation freshness for a PEER-gateway-sourced row (this gateway's own local
		// rows never carry it - absent, not a fourth "local" value). "unreachable" is the honest
		// stale-mark Q4 requires; "quiet" is healthy idle, not stale.
		presenceFresh: z.enum(["fresh", "quiet", "unreachable"]).optional(),
	})
	.meta({ id: "TeamInfo" });

/** One source gateway's presence-plane version, as carried on the wire: an array of these, never a
 * map, since codegen has no typed map. `gateway` is the source gateway's id. */
export const PresenceVersionSchema = z
	.object({
		gateway: z.string(),
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "PresenceVersion" });

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

/** One synced read stream. */
export const ReadAnchorWireEntrySchema = z
	.object({
		stream: z.string(),
		epoch: z.number().int(),
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorWireEntry" });
