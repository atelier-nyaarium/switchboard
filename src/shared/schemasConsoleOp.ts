import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { SignedXDomainLinkSchema } from "./federation-protocol.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";
import { AuthorizationPolicySchema } from "./schemasPolicy.js";
import { RoutineSchema } from "./schemasRoutine.js";
import { RunbookFireTargetSchema, RunbookSchema } from "./schemasRunbook.js";
import { VaultDecisionSchema } from "./schemasVault.js";

export { SealedEnvelopeSchema } from "./crypto.js";

export const CrossDomainShareTargetSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("domain"), domainId: z.string().min(1).max(64) }),
		z.object({ kind: z.literal("everyone_trusted") }),
	])
	.meta({ id: "CrossDomainShareTarget" });

export const MAX_POLL_HOLD_MS = 45_000;

export const ConsoleOpSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("send"),
				to: z.string().min(1).max(128),
				domainId: z.string().min(1).max(64).optional(),
				// Empty when files are the message.
				body: z.string(),
				files: ChannelFilesSchema.optional(),
			})
			.refine((op) => op.body.length > 0 || (op.files?.length ?? 0) > 0, {
				error: "a send carries text or files",
				path: ["body"],
			}),
		z.object({
			kind: z.literal("respond"),
			session_id: z.string().min(1),
			status: z.string().optional(),
			response: z.string().optional(),
			replyAsJson: z.record(z.string(), z.unknown()).optional(),
			files: ChannelFilesSchema.optional(),
		}),
		z.object({
			kind: z.literal("peek"),
			target: z.string().min(1).max(128),
			sinceHash: z.string().max(64).optional(),
		}),
		z.object({
			kind: z.literal("tmux_send"),
			target: z.string().min(1).max(128),
			text: z.string().max(4096).optional(),
			key: z.string().max(32).optional(),
			submit: z.boolean().optional(),
		}),
		z.object({
			kind: z.literal("create_session"),
			target: z.string().min(1).max(128),
			sessionName: z.string().min(1).max(64).optional(),
			displayLabel: z.string().min(1).max(64).optional(),
			workdir: z.string().min(1).max(512).optional(),
		}),
		z.object({
			kind: z.literal("reload_plugins"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("forget"),
			target: z.string().min(1).max(128),
			boardDisposition: z.enum(["release", "cancel"]).optional(),
		}),
		z.object({
			kind: z.literal("close_session"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("rename_session"),
			target: z.string().min(1).max(128),
			sessionLabel: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("wake"),
			target: z.string().min(1).max(128),
		}),
		z.object({
			kind: z.literal("list_dirs"),
			path: z.string().max(512),
			spawn: z.string().min(1).max(64).optional(),
		}),
		// One kind each as every other feature does, so Kotlin gets real classes rather than an opaque
		// payload. `target` names a session, never a spawn point.
		z.object({
			kind: z.literal("workspace_tree"),
			target: z.string().min(1).max(128),
			path: z.string().max(512),
		}),
		z.object({
			kind: z.literal("workspace_file"),
			target: z.string().min(1).max(128),
			path: z.string().max(512),
		}),
		z.object({
			kind: z.literal("workspace_outline"),
			target: z.string().min(1).max(128),
			path: z.string().max(512),
		}),
		z.object({
			kind: z.literal("workspace_symbol_source"),
			target: z.string().min(1).max(128),
			symbolId: z.string().min(1).max(1024),
		}),
		z.object({
			kind: z.literal("workspace_symbol_knowledge"),
			target: z.string().min(1).max(128),
			symbolId: z.string().min(1).max(1024),
		}),
		// The one write: lands only while the span still hashes to what the owner was shown.
		z.object({
			kind: z.literal("workspace_save_span"),
			target: z.string().min(1).max(128),
			symbolId: z.string().min(1).max(1024),
			expectedSpanHash: z.string().min(1).max(128),
			text: z.string().max(4_000_000),
		}),
		z.object({ kind: z.literal("cross_domain_listen") }),
		z.object({
			kind: z.literal("cross_domain_request"),
			listeningToken: z.string().min(1),
			pin: z.string().min(1),
			requesterOwnerSignPub: z.string().min(1),
			requesterDomainId: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("cross_domain_confirm"),
			pin: z.string().min(1),
			mySignedLink: SignedXDomainLinkSchema,
		}),
		z.object({
			kind: z.literal("cross_domain_listen_state"),
			listeningToken: z.string().min(1),
		}),
		z.object({
			kind: z.literal("cross_domain_cancel"),
			listeningToken: z.string().optional(),
			pin: z.string().optional(),
		}),
		z.object({ kind: z.literal("cross_domain_list_peers") }),
		z.object({
			kind: z.literal("cross_domain_unlink"),
			domainId: z.string().min(1).max(64),
		}),
		z.object({
			kind: z.literal("cross_domain_untrust"),
			ownerSignPub: z.string().min(1).max(128),
		}),
		// Typed values bind request IDs. A note on a deny steers the asker.
		z.object({
			kind: z.literal("vault_answer"),
			requestId: z.string().min(1).max(128),
			decision: VaultDecisionSchema,
			value: ContentEnvelopeSchema.optional(),
			note: z.string().max(2048).optional(),
		}),
		z.object({ kind: z.literal("vault_grants") }),
		z.object({ kind: z.literal("vault_revoke"), grantId: z.string().min(1).max(128) }),
		z.object({ kind: z.literal("runbook_list") }),
		// Whole record, never a patch.
		z.object({
			kind: z.literal("runbook_put"),
			runbook: RunbookSchema,
			/**
			 * The revision the editor was opened at, absent on a first save. The gateway stores at its
			 * own successor, so the runbook's own revision field is not read here.
			 */
			baseRevision: z.number().int().positive().optional(),
			/** Owner-authorized. Replaces whatever revision is held. */
			overwrite: z.boolean().optional(),
		}),
		z.object({ kind: z.literal("runbook_delete"), runbookId: z.string().min(1).max(64) }),
		z.object({
			kind: z.literal("runbook_preview"),
			runbookId: z.string().min(1).max(64),
			values: z.record(z.string(), z.string()),
		}),
		z.object({
			kind: z.literal("runbook_fire"),
			runbookId: z.string().min(1).max(64),
			values: z.record(z.string(), z.string()),
			into: RunbookFireTargetSchema,
			/** The revision the owner previewed. A newer stored one refuses rather than fires. */
			expectedRevision: z.number().int().positive().optional(),
		}),
		z.object({ kind: z.literal("routine_list") }),
		// Whole record, never a patch, as a runbook is.
		z.object({
			kind: z.literal("routine_put"),
			routine: RoutineSchema,
			/**
			 * The revision the editor was opened at, absent on a first save. The gateway stores at its
			 * own successor, so the phone never names the revision it wants.
			 */
			baseRevision: z.number().int().positive().optional(),
		}),
		/** What a candidate would next run at, so the phone names an instant without holding a rule. */
		z.object({ kind: z.literal("routine_next"), routine: RoutineSchema }),
		z.object({ kind: z.literal("routine_delete"), routineId: z.string().min(1).max(64) }),
		z.object({
			kind: z.literal("routine_enable"),
			routineId: z.string().min(1).max(64),
			enabled: z.boolean(),
			// Optional until 2026-09-24 for phones that toggle without it; then required.
			baseRevision: z.number().int().positive().optional(),
		}),
		// Run now and Dismiss answer an occurrence the owner is looking at, never the routine.
		z.object({
			kind: z.literal("routine_run_now"),
			routineId: z.string().min(1).max(64),
			occurrenceId: z.string().min(1).max(128),
		}),
		/**
		 * A fresh run, named by the routine alone. It carries no instant because the gateway owns
		 * `now`, and it is not `routine_run_now`, which re-runs a slot the rule named and the owner is
		 * looking at.
		 */
		z.object({ kind: z.literal("routine_run"), routineId: z.string().min(1).max(64) }),
		z.object({
			kind: z.literal("routine_dismiss"),
			routineId: z.string().min(1).max(64),
			occurrenceId: z.string().min(1).max(128),
		}),
		z.object({ kind: z.literal("policy_list") }),
		// Whole record, never a patch.
		z.object({
			kind: z.literal("policy_put"),
			policy: AuthorizationPolicySchema,
			/** Absent on create. */
			baseRevision: z.number().int().positive().optional(),
		}),
		// Base revision required.
		z.object({
			kind: z.literal("policy_delete"),
			policyId: z.string().min(1).max(64),
			baseRevision: z.number().int().positive(),
		}),
		z.object({
			kind: z.literal("policy_enable"),
			policyId: z.string().min(1).max(64),
			enabled: z.boolean(),
			baseRevision: z.number().int().positive(),
		}),
	])
	.meta({ id: "ConsoleOp" });

export const DELIVERY_OP_KINDS = new Set([
	"send",
	"respond",
	"tmux_send",
	"rename_session",
	"close_session",
	"forget",
	"wake",
]);

export const TOLERATED_DELIVERY_OP_KINDS = new Set<string>();

export const VALUE_OP_KINDS = new Set([
	"peek",
	"list_dirs",
	"workspace_tree",
	"workspace_file",
	"workspace_outline",
	"workspace_symbol_source",
	"workspace_symbol_knowledge",
	"workspace_save_span",
	"create_session",
	"reload_plugins",
	"cross_domain_listen",
	"cross_domain_request",
	"cross_domain_confirm",
	"cross_domain_listen_state",
	"cross_domain_cancel",
	"cross_domain_list_peers",
	"cross_domain_unlink",
	"cross_domain_untrust",
	"vault_answer",
	"vault_grants",
	"vault_revoke",
	"runbook_list",
	"runbook_put",
	"runbook_delete",
	"runbook_preview",
	"runbook_fire",
	"routine_list",
	"routine_put",
	"routine_next",
	"routine_delete",
	"routine_enable",
	"routine_run_now",
	"routine_run",
	"routine_dismiss",
	"policy_list",
	"policy_put",
	"policy_delete",
	"policy_enable",
]);

export const MailboxEntrySchema = z
	.object({
		seq: z.number().int().nonnegative(),
		at: z.number().int().nonnegative(),
		kind: z.enum(["message", "reply", "notice", "sent", "peer", "plugin_action"]),
		session_id: z.string(),
		from: z.string().optional(),
		to: z.string().optional(),
		dedupeKey: z.string().optional(),
		opId: z.string().optional(),
		title: z.string().optional(),
		summary: z.string().optional(),
		body: z.string().optional(),
		fullSpoken: z.string().optional(),
		status: z.string().optional(),
		files: ChannelFilesSchema.optional(),
		pluginId: z.string().optional(),
		actionType: z.string().optional(),
		payload: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "MailboxEntry" });
