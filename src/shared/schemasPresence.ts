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
		// Plugin version reported at register.
		version: z.string().optional(),
		// Epoch ms last seen; absent without a resume record.
		lastActive: z.number().int().optional(),
		queue_depth: z.number().int().nonnegative(),
		// Absent means unknown, never false.
		...ProjectedPresenceSchema.shape,
		// Peer-sourced rows only; "quiet" is healthy idle, not stale.
		presenceFresh: z.enum(["fresh", "quiet", "unreachable"]).optional(),
	})
	.meta({ id: "TeamInfo" });

/** An array, never a map: codegen has no typed map. */
export const PresenceVersionSchema = z
	.object({
		gateway: z.string(),
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "PresenceVersion" });

/** A single-source plane's version. */
export const LinkedPeersVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "LinkedPeersVersion" });

// A linked friend Domain's peer row; domainId repeats once per gateway.
export const CrossDomainPeerEntrySchema = z
	.object({
		domainId: z.string(),
		gatewayId: z.string(),
		// The friend owner's signing key, base64.
		ownerSignPub: z.string(),
	})
	.meta({ id: "CrossDomainPeerEntry" });

/** One scalar per owner. */
export const ReadAnchorsVersionSchema = z
	.object({
		epoch: z.number().int(),
		version: z.number().int().nonnegative(),
	})
	.meta({ id: "ReadAnchorsVersion" });

/** One scalar per owner. */
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
