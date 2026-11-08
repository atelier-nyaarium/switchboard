import { z } from "zod";
import { WORKFLOW_AGENT_OUTCOMES } from "../../shared/workflow-agent-outcome.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const WorkflowBackendSchema = z.enum(["codex", "copilot", "claude"]);

/** Claude instruction paths. */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const WorkflowRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export const WorkflowTerminalStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);

export const WorkflowRunRecordSchema = z
	.object({
		runId: z.string().min(1),
		team: z.string().min(1),
		startOperationId: z.string().min(1),
		resumeFrom: z.string().min(1).nullable(),
		script: z.string(),
		args: JsonObjectSchema,
		defaultBackend: WorkflowBackendSchema,
		phases: z.array(z.string()),
		status: WorkflowRunStatusSchema,
		result: JsonValueSchema,
		failureReason: z.string().nullable(),
		notified: z.boolean(),
		collected: z.boolean(),
		createdAt: z.number().finite().nonnegative(),
		settledAt: z.number().finite().nonnegative().nullable(),
	})
	.strict()
	.superRefine((record, context) => {
		if (record.status === "running" && record.settledAt !== null) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["settledAt"], message: "running run is settled" });
		}
		if (record.collected && !record.notified) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["notified"],
				message: "collected run is not notified",
			});
		}
		if (record.status === "running" && record.collected) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["collected"], message: "running run is collected" });
		}
		if (record.status === "running" && (record.result !== null || record.failureReason !== null)) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "running run has a result" });
		}
		if (record.status !== "running" && record.settledAt === null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["settledAt"],
				message: "terminal run is unsettled",
			});
		}
		if (record.status === "failed" && record.failureReason === null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["failureReason"],
				message: "failed run has no reason",
			});
		}
	});

export const WorkflowCallOptionsSchema = z
	.object({
		backend: WorkflowBackendSchema.optional(),
		model: z.string().optional(),
		effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
		tier: z.string().optional(),
		schema: JsonObjectSchema.optional(),
		skills: z.array(z.string()).optional(),
		thread: z.string().optional(),
		label: z.string().optional(),
		phase: z.string().optional(),
	})
	.strict();

export const WorkflowIssueRowSchema = z
	.object({
		kind: z.literal("issue"),
		issueOrdinal: z.number().int().positive(),
		callHash: z.string().regex(/^[0-9a-f]{64}$/),
		prompt: z.string(),
		resolvedBackend: WorkflowBackendSchema,
		options: WorkflowCallOptionsSchema,
	})
	.strict();

export const WorkflowTurnRowSchema = z
	.object({
		kind: z.literal("turn"),
		issueOrdinal: z.number().int().positive(),
		turnOrdinal: z.number().int().positive(),
		turnId: z.string().min(1),
		backend: WorkflowBackendSchema,
		prompt: z.string(),
		operationId: z.string().min(1).nullable(),
		registerInstanceId: z.string().min(1).nullable(),
		agentId: z.string().min(1).nullable(),
		target: z.string().min(1).nullable(),
	})
	.strict()
	.superRefine((row, context) => {
		if (row.backend === "claude") {
			if (row.operationId !== null) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["operationId"],
					message: "claude turn has an operation id",
				});
			}
			for (const field of ["registerInstanceId", "agentId", "target"] as const) {
				if (row[field] === null) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: [field],
						message: "claude turn field is missing",
					});
				}
			}
			if (row.agentId !== null && !z.string().uuid().safeParse(row.agentId).success) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["agentId"],
					message: "claude turn agent id is not a session uuid",
				});
			}
			return;
		}
		for (const field of ["operationId", "registerInstanceId", "agentId", "target"] as const) {
			if (row[field] === null) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [field],
					message: "agent turn field is missing",
				});
			}
		}
	});

export const WorkflowThreadMapRowSchema = z
	.object({
		kind: z.literal("thread_map"),
		thread: z.string().min(1),
		backend: WorkflowBackendSchema,
		agentId: z.string().min(1),
		target: z.string().min(1),
		lastIssueOrdinal: z.number().int().positive(),
	})
	.strict()
	.superRefine((row, context) => {
		if (row.backend === "claude" && !z.string().uuid().safeParse(row.agentId).success) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["agentId"],
				message: "claude thread agent id is not a session uuid",
			});
		}
	});

export const WorkflowSettleRowSchema = z
	.object({
		kind: z.literal("settle"),
		settleOrdinal: z.number().int().positive(),
		issueOrdinal: z.number().int().positive(),
		outcome: z.enum(WORKFLOW_AGENT_OUTCOMES),
		answer: JsonValueSchema.nullable(),
		reason: z.string().min(1).nullable(),
		threadMap: WorkflowThreadMapRowSchema.optional(),
	})
	.strict()
	.superRefine((row, context) => {
		if (row.outcome === "completed" && row.reason !== null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["reason"],
				message: "completed settle has a reason",
			});
		}
		if (row.outcome !== "completed" && row.reason === null) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "settle reason is missing" });
		}
	});

export const WorkflowSkillTextRowSchema = z
	.object({
		kind: z.literal("skill_text"),
		path: z.string().min(1),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		text: z.string().optional(),
	})
	.strict();

export const WorkflowJournalRowSchema = z.union([
	WorkflowIssueRowSchema,
	WorkflowTurnRowSchema,
	WorkflowSettleRowSchema,
	WorkflowThreadMapRowSchema,
	WorkflowSkillTextRowSchema,
]);

/** Ordered thread mappings. */
export function threadMapsOf(rows: readonly WorkflowJournalRow[]): Array<z.infer<typeof WorkflowThreadMapRowSchema>> {
	return rows.flatMap((row) =>
		row.kind === "thread_map" ? [row] : row.kind === "settle" && row.threadMap ? [row.threadMap] : [],
	);
}

export const WorkflowStartInputSchema = z
	.object({
		team: z.string().min(1),
		operationId: z.string().min(1),
		resumeFrom: z.string().min(1).nullable(),
		script: z.string(),
		args: JsonObjectSchema,
		defaultBackend: WorkflowBackendSchema,
		phases: z.array(z.string()),
	})
	.strict();

export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowTerminalStatus = z.infer<typeof WorkflowTerminalStatusSchema>;
export type WorkflowJournalRow = z.infer<typeof WorkflowJournalRowSchema>;
export type WorkflowCallOptions = z.infer<typeof WorkflowCallOptionsSchema>;
export type WorkflowIssueRow = z.infer<typeof WorkflowIssueRowSchema>;
export type WorkflowSettleRow = z.infer<typeof WorkflowSettleRowSchema>;
export type WorkflowStartInput = z.infer<typeof WorkflowStartInputSchema>;
