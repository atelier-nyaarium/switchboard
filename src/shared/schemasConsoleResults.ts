import { z } from "zod";
import { DomainSnapshotSchema } from "./admission.js";
import { ConsoleAssistantStateResultSchema } from "./schemasAssistant.js";
import { ConsoleAssistantPreviewResultSchema, ConsoleAssistantRulesResultSchema } from "./schemasAssistantRules.js";
import { ConsoleAssistantSendAnswerResultSchema } from "./schemasAssistantSend.js";
import { BoardEntrySchema } from "./schemasBoard.js";
import { CrossDomainShareTargetSchema, MailboxEntrySchema } from "./schemasConsoleOp.js";
import { DomainStatusSchema } from "./schemasCore.js";
import { DEVICE_CONSOLE_RESULTS } from "./schemasDevices.js";
import {
	ConsolePolicyDeleteResultSchema,
	ConsolePolicyListResultSchema,
	ConsolePolicyPutResultSchema,
} from "./schemasPolicy.js";
import {
	CrossDomainPeerEntrySchema,
	LinkedPeersVersionSchema,
	PresenceVersionSchema,
	ReadAnchorsVersionSchema,
	ReadAnchorWireEntrySchema,
	SessionPromptSchema,
	TaskBoardVersionSchema,
	TeamInfoSchema,
} from "./schemasPresence.js";
import {
	ConsoleRoutineDeleteResultSchema,
	ConsoleRoutineListResultSchema,
	ConsoleRoutineNextResultSchema,
	ConsoleRoutineOccurrenceResultSchema,
	ConsoleRoutinePutResultSchema,
	ConsoleRoutineRunResultSchema,
} from "./schemasRoutine.js";
import {
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookFireResultSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPreviewResultSchema,
	ConsoleRunbookPutResultSchema,
} from "./schemasRunbook.js";
import {
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
} from "./schemasVault.js";
import { WorkspaceOpAnswerSchema } from "./schemasWorkspace.js";
import { SESSION_HARNESSES } from "./session-harness.js";

////////////////////////////////
//  Op result schemas (gateway -> console)
//  No wire discriminator; each generates its own Kotlin class.

export const ConsoleRegisterResultSchema = z
	.object({
		device: z.string(),
		// The connected Gateway's id; always sent.
		gatewayId: z.string(),
		// Mailbox high-water seq.
		cursor: z.number().int().nonnegative(),
		// A changed epoch means the console resets its cursor to 0.
		epoch: z.number().int().nonnegative(),
		// Never `pending`; absent until the Router register completes, read as rooted.
		domainStatus: DomainStatusSchema.optional(),
	})
	.meta({ id: "ConsoleRegisterResult" });

/** How complete a fan-out is; `rosterKnown: false` means `asked` says nothing. */
export const DiscoverCoverageSchema = z
	.object({
		rosterKnown: z.boolean(),
		asked: z.number().int().nonnegative(),
		answered: z.number().int().nonnegative(),
		unreachable: z.array(z.string().max(64)).max(64).optional(),
		// As "domainId/gatewayId".
		unreachablePeers: z.array(z.string().max(130)).max(64).optional(),
	})
	.meta({ id: "DiscoverCoverage" });

/** `/discover?coverage=1` response. */
export const SpawnClisSchema = z
	.object({
		domainId: z.string().min(1),
		gatewayId: z.string().min(1),
		spawn: z.string().min(1).max(64),
		clis: z.array(z.enum(SESSION_HARNESSES)).max(SESSION_HARNESSES.length),
	})
	.meta({ id: "SpawnClis" });

export type SpawnClis = z.infer<typeof SpawnClisSchema>;

export const DiscoverAnswerSchema = z
	.object({
		teams: z.array(TeamInfoSchema),
		coverage: DiscoverCoverageSchema,
		localGatewayId: z.string().min(1),
		localDomainId: z.string().min(1),
		/** Spawn points whose CLIs are known. */
		spawnClis: z.array(SpawnClisSchema).max(512).optional(),
	})
	.meta({ id: "DiscoverAnswer" });

export const ConsoleSendResultSchema = z
	.object({
		session_id: z.string(),
		status: z.string(),
	})
	.meta({ id: "ConsoleSendResult" });

export const ConsoleRespondResultSchema = z
	.object({
		delivered: z.boolean(),
	})
	.meta({ id: "ConsoleRespondResult" });

export const ConsolePollResultSchema = z
	.object({
		entries: z.array(MailboxEntrySchema),
		cursor: z.number().int().nonnegative(),
		// Entries evicted before read; never reset.
		dropped: z.number().int().nonnegative(),
		// A changed epoch means the console resets its cursor to 0.
		epoch: z.number().int().nonnegative(),
		// Present only when changed from the console's known version.
		domainVersion: z.string().optional(),
		domain: DomainSnapshotSchema.optional(),
		// Each plane ships with its version, never one without the other.
		presence: z.array(TeamInfoSchema).optional(),
		presenceVersions: z.array(PresenceVersionSchema).optional(),
		linkedPeers: z.array(CrossDomainPeerEntrySchema).optional(),
		linkedPeersVersion: LinkedPeersVersionSchema.optional(),
		readAnchors: z.array(ReadAnchorWireEntrySchema).optional(),
		readAnchorsVersion: ReadAnchorsVersionSchema.optional(),
		// Truncated marks a byte-budgeted subset.
		taskBoard: z.array(BoardEntrySchema).optional(),
		taskBoardVersion: TaskBoardVersionSchema.optional(),
		taskBoardTruncated: z.boolean().optional(),
		// What woke the poll; a plane-only settle is not a broken gateway.
		settled: z
			.enum(["mailbox", "presence", "linkedPeers", "readAnchors", "taskBoard", "domain", "timeout"])
			.optional(),
	})
	.meta({ id: "ConsolePollResult" });

export const ConsolePeekResultSchema = z
	.object({
		// The ANSI pane; absent when sinceHash matched.
		ansi: z.string().optional(),
		// Container log tail, instead of `ansi` while no pane exists.
		text: z.string().optional(),
		// Flat, not a union: Kotlin codegen drops a decode-side union root.
		kind: z.enum(["tmux", "container-logs"]).optional(),
		// Echoed back as sinceHash.
		hash: z.string(),
		unchanged: z.boolean().optional(),
	})
	.meta({ id: "ConsolePeekResult" });

export const ConsoleTmuxSendResultSchema = z
	.object({
		sent: z.boolean(),
	})
	.meta({ id: "ConsoleTmuxSendResult" });

export const ConsoleReportReadResultSchema = z
	.object({
		// False when another device already reported as far.
		advanced: z.boolean(),
	})
	.meta({ id: "ConsoleReportReadResult" });

export const ConsoleCreateSessionResultSchema = z
	.object({
		// The agent boots after this returns.
		created: z.boolean(),
		id: z.string(),
		sessionLabel: z.string().optional(),
		// True only when a supplied displayLabel was rejected and the id stands in.
		labelSanitized: z.boolean().optional(),
		// Present when a cold bring-up outran the bound and continues in the background.
		status: z.enum(["pending"]).optional(),
	})
	.meta({ id: "ConsoleCreateSessionResult" });

/** Queued; how it went rides the container state. */
export const ConsoleContainerResultSchema = z.object({ accepted: z.boolean() }).meta({ id: "ConsoleContainerResult" });

export const ConsoleReloadPluginsResultSchema = z
	.object({
		initiated: z.boolean(),
	})
	.meta({ id: "ConsoleReloadPluginsResult" });

export const ConsoleSessionPromptResultSchema = z
	.object({
		// Null when none waits.
		prompt: SessionPromptSchema.nullable(),
	})
	.meta({ id: "ConsoleSessionPromptResult" });

export const ConsoleSessionPromptAnswerResultSchema = z
	.object({
		// Stale: another prompt, or none.
		outcome: z.enum(["answered", "stale"]),
	})
	.meta({ id: "ConsoleSessionPromptAnswerResult" });

export const ConsoleForgetResultSchema = z
	.object({
		// Also true when already gone.
		killed: z.boolean(),
		// Absent means an older Gateway downgraded the request.
		boardDisposition: z.enum(["release", "cancel"]).optional(),
	})
	.meta({ id: "ConsoleForgetResult" });

export const ConsoleCloseSessionResultSchema = z
	.object({
		// The resume record is kept; also true when already gone.
		closed: z.boolean(),
	})
	.meta({ id: "ConsoleCloseSessionResult" });

export const ConsoleRenameSessionResultSchema = z
	.object({
		renamed: z.boolean(),
		// After sanitize and per-spawn dedup.
		sessionLabel: z.string().optional(),
	})
	.meta({ id: "ConsoleRenameSessionResult" });

export const ConsoleListDirsResultSchema = z
	.object({
		// Sorted subdirectory names; empty for an unreadable path.
		entries: z.array(z.string()),
		// The wire bound cut the listing.
		truncated: z.boolean().optional(),
		// Answered only for a blank request: the spawn point's default directory.
		path: z.string().max(512).optional(),
	})
	.meta({ id: "ConsoleListDirsResult" });

////////////////////////////////
//  Cross-Domain handshake op results (gateway -> console)

export const CrossDomainListenResultSchema = z
	.object({
		// Single-use, `<gatewayId>.<random>`.
		listeningToken: z.string(),
		receiverOwnerSignPub: z.string(),
		receiverGatewaySignPub: z.string(),
		receiverGatewayBoxPub: z.string(),
		receiverDomainId: z.string(),
		receiverGatewayId: z.string(),
		// Epoch ms.
		expiresAt: z.number().int(),
	})
	.meta({ id: "CrossDomainListenResult" });

export const CrossDomainRequestResultSchema = z
	.object({
		// The safety code both humans compare.
		sas: z.string(),
		requesterOwnerSignPub: z.string(),
		receiverOwnerSignPub: z.string(),
		receiverDomainId: z.string(),
		receiverGatewayId: z.string(),
		// Bound by the requester's owner-signed link.
		receiverGatewaySignPub: z.string(),
		receiverGatewayBoxPub: z.string(),
	})
	.meta({ id: "CrossDomainRequestResult" });

export const CrossDomainConfirmResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainConfirmResult" });

export const CrossDomainCancelResultSchema = z
	.object({
		cancelled: z.boolean(),
	})
	.meta({ id: "CrossDomainCancelResult" });

// The receiver's listening window; the SAS and friend keys appear once a pairing arrives.
export const CrossDomainListenStateResultSchema = z
	.object({
		pairingArrived: z.boolean(),
		// Requester-minted, single-use; consumed at confirm.
		pin: z.string().optional(),
		// Identical to the requester's.
		sas: z.string().optional(),
		// The keys the receiver owner-signs a link over.
		friendOwnerSignPub: z.string().optional(),
		friendGatewaySignPub: z.string().optional(),
		friendGatewayBoxPub: z.string().optional(),
		friendDomainId: z.string().optional(),
		friendGatewayId: z.string().optional(),
		// Epoch ms; absent once the window is gone.
		expiresAt: z.number().int().optional(),
		// Unknown token, expired or cancelled.
		expired: z.boolean().optional(),
	})
	.meta({ id: "CrossDomainListenStateResult" });

////////////////////////////////
//  Per-session share op results (gateway -> console)

export const CrossDomainShareResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainShareResult" });

export const CrossDomainUnshareResultSchema = z
	.object({
		ok: z.boolean(),
	})
	.meta({ id: "CrossDomainUnshareResult" });

// Named so codegen emits a nested class.
export const CrossDomainShareEntrySchema = z
	.object({
		sessionTarget: z.string(),
		target: CrossDomainShareTargetSchema,
	})
	.meta({ id: "CrossDomainShareEntry" });

export const CrossDomainListSharesResultSchema = z
	.object({
		shares: z.array(CrossDomainShareEntrySchema),
	})
	.meta({ id: "CrossDomainListSharesResult" });

// A written link implies neither presence nor shared-back state.
export const CrossDomainListPeersResultSchema = z
	.object({
		peers: z.array(CrossDomainPeerEntrySchema),
	})
	.meta({ id: "CrossDomainListPeersResult" });

// Counts local teardown effects.
export const CrossDomainUnlinkResultSchema = z
	.object({
		peersRemoved: z.number().int().nonnegative(),
		sharesDropped: z.number().int().nonnegative(),
		// In-flight jobs failed fast.
		jobsExpired: z.number().int().nonnegative(),
	})
	.meta({ id: "CrossDomainUnlinkResult" });

/** A refusal is ok=false plus error on the reply body, never here. */
export const ConsoleOpResultSchema = z.union([
	ConsoleRegisterResultSchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsolePollResultSchema,
	ConsoleReportReadResultSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleContainerResultSchema,
	ConsoleSessionPromptResultSchema,
	ConsoleSessionPromptAnswerResultSchema,
	ConsoleForgetResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleListDirsResultSchema,
	WorkspaceOpAnswerSchema,
	CrossDomainListenResultSchema,
	CrossDomainRequestResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainCancelResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainUnshareResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainUnlinkResultSchema,
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPutResultSchema,
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookPreviewResultSchema,
	ConsoleRunbookFireResultSchema,
	ConsoleRoutineListResultSchema,
	ConsoleRoutinePutResultSchema,
	ConsoleRoutineDeleteResultSchema,
	ConsoleRoutineNextResultSchema,
	ConsoleRoutineOccurrenceResultSchema,
	ConsoleRoutineRunResultSchema,
	ConsolePolicyListResultSchema,
	ConsolePolicyPutResultSchema,
	ConsolePolicyDeleteResultSchema,
	...Object.values(DEVICE_CONSOLE_RESULTS),
	ConsoleAssistantStateResultSchema,
	ConsoleAssistantRulesResultSchema,
	ConsoleAssistantPreviewResultSchema,
	ConsoleAssistantSendAnswerResultSchema,
]);

////////////////////////////////
//  Console Reply Body (the sealed inner reply)
