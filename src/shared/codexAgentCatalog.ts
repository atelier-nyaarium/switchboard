// Codex delegation: the owner-scoped catalog of persisted agents, the public list projection of one
// agent's history, restoring a catalog from durable storage (with the migration a pre-fence record
// needs), and building the projection from a private CodexPersistedAgent.

import { z } from "zod";
import { restoreAgentCatalog } from "./agent-record.js";
import { withTurnMarks } from "./agent-turn-marks.js";
import { CodexPersistedAgentSchema } from "./codexAgentRecord.js";
import { CodexReconciliationFenceSchema } from "./codexAgentRelay.js";

export const CodexAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CodexPersistedAgentSchema),
	})
	.strict()
	.superRefine((value, ctx) => {
		const agentIds = new Set<string>();
		const operationIds = new Set<string>();
		for (const [index, agent] of value.agents.entries()) {
			if (agentIds.has(agent.agentId)) {
				ctx.addIssue({
					code: "custom",
					message: "agent IDs must be unique within an owner catalog",
					path: ["agents", index, "agentId"],
				});
			}
			agentIds.add(agent.agentId);
			for (const operation of agent.operations) {
				if (operationIds.has(operation.operationId)) {
					ctx.addIssue({
						code: "custom",
						message: "operation IDs must be unique within an owner catalog",
						path: ["agents", index, "operations"],
					});
				}
				operationIds.add(operation.operationId);
			}
		}
	});

export type CodexAgentCatalog = z.infer<typeof CodexAgentCatalogSchema>;

function migrateCodexAgentRecoveryIntent(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const agent = raw as Record<string, unknown>;
	if (!Array.isArray(agent.operations)) return raw;
	const threadId = typeof agent.threadId === "string" ? agent.threadId : undefined;
	const agentFence = CodexReconciliationFenceSchema.safeParse(agent.fence);
	let hasUnverifiedAcceptance = false;
	const operations = agent.operations.map((candidate) => {
		if (!candidate || typeof candidate !== "object") return candidate;
		const operation = candidate as Record<string, unknown>;
		let migrated = operation;
		if (operation.preDispatch === undefined) {
			switch (operation.kind) {
				case "start":
					migrated = { ...operation, preDispatch: { agentState: "creating" } };
					break;
				case "message": {
					const turnId = typeof operation.expectedTurnId === "string" ? operation.expectedTurnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
				case "stop": {
					const turnId = typeof operation.turnId === "string" ? operation.turnId : undefined;
					migrated = {
						...operation,
						preDispatch: { agentState: turnId ? "working" : "idle", threadId, turnId },
					};
					break;
				}
			}
		}
		if (
			migrated.kind !== "start" &&
			migrated.preDispatch &&
			typeof migrated.preDispatch === "object" &&
			!("fence" in migrated.preDispatch) &&
			agentFence.success
		) {
			migrated = {
				...migrated,
				preDispatch: { ...(migrated.preDispatch as Record<string, unknown>), fence: agentFence.data },
			};
		}
		if (
			(migrated.kind === "start" || migrated.kind === "message") &&
			migrated.state === "accepted" &&
			migrated.acceptanceFence === undefined &&
			migrated.acceptanceUnverified === undefined
		) {
			hasUnverifiedAcceptance = true;
			migrated = { ...migrated, acceptanceUnverified: true };
		}
		if (migrated.acceptanceUnverified === true) hasUnverifiedAcceptance = true;
		return migrated;
	});
	return {
		...agent,
		agentState: hasUnverifiedAcceptance ? "recovering" : agent.agentState,
		operations,
	};
}

/** Restore a session-owned catalog without sacrificing its owner to one damaged agent entry. */
export function restoreCodexAgentCatalog(raw: unknown): CodexAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = CodexPersistedAgentSchema.safeParse(withTurnMarks(migrateCodexAgentRecoveryIntent(candidate)));
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = CodexAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}
