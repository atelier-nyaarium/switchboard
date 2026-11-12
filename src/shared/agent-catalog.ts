import { z } from "zod";
import { PersistedAgentSchema } from "./agent-persisted.js";
import { restoreAgentCatalog } from "./agent-record.js";
import { withTurnMarks } from "./agent-turn-marks.js";

/** Per-owner, per-backend catalog. */
export const PersistedAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(PersistedAgentSchema),
	})
	.strict()
	.superRefine((value, ctx) => {
		const agentIds = new Set<string>();
		const operationIds = new Set<string>();
		for (const [index, agent] of value.agents.entries()) {
			if (agentIds.has(agent.agentId))
				ctx.addIssue({ code: "custom", message: "agent IDs must be unique", path: ["agents", index] });
			agentIds.add(agent.agentId);
			for (const operation of agent.operations) {
				if (operationIds.has(operation.operationId))
					ctx.addIssue({ code: "custom", message: "operation IDs must be unique", path: ["agents", index] });
				operationIds.add(operation.operationId);
			}
		}
	});

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upgraded(raw: unknown): unknown {
	if (!isRaw(raw) || raw.version !== 1) return raw;
	return Array.isArray(raw.exchanges) ? fromExchangeRecord(raw) : fromOperationRecord(raw);
}

function fromOperationRecord(raw: Raw): unknown {
	const operations = Array.isArray(raw.operations)
		? raw.operations.map((operation) =>
				isRaw(operation) && operation.delivery === "followup"
					? { ...operation, delivery: "started" }
					: operation,
			)
		: raw.operations;
	return { ...raw, version: 2, operations };
}

function fromExchangeRecord(raw: Raw): unknown {
	const { threadId, exchanges, pendingInterrupt: _pendingInterrupt, ...rest } = raw;
	const byOperation = new Map<unknown, Raw>();
	for (const exchange of exchanges as unknown[]) if (isRaw(exchange)) byOperation.set(exchange.operationId, exchange);
	const operations = Array.isArray(raw.operations)
		? raw.operations.map((candidate) => {
				if (!isRaw(candidate)) return candidate;
				const {
					preDispatch: _preDispatch,
					acceptanceFence: _acceptanceFence,
					acceptanceUnverified: _acceptanceUnverified,
					noOp: _noOp,
					...operation
				} = candidate;
				const exchange = byOperation.get(operation.operationId);
				const aimed = operation.kind !== "start" || operation.state === "accepted";
				return {
					...operation,
					...(exchange?.prompt === undefined ? {} : { prompt: exchange.prompt }),
					...(exchange?.model === undefined ? {} : { model: exchange.model }),
					...(exchange?.outputSchema === undefined ? {} : { outputSchema: exchange.outputSchema }),
					...(exchange?.delivery === undefined ? {} : { delivery: exchange.delivery }),
					...(aimed && threadId !== undefined ? { sessionId: threadId } : {}),
				};
			})
		: raw.operations;
	return { ...rest, version: 2, ...(threadId === undefined ? {} : { sessionId: threadId }), operations };
}

/** A damaged entry is dropped alone; a duplicated id drops every claimant. */
export function restorePersistedAgentCatalog(raw: unknown): PersistedAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = PersistedAgentSchema.safeParse(withTurnMarks(upgraded(candidate)));
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = PersistedAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}

export type PersistedAgentCatalog = z.infer<typeof PersistedAgentCatalogSchema>;
