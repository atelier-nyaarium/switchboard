import { z } from "zod";
import { CONSOLE_SOURCE_MAX, isConsoleVariableName } from "./live-console-grammar.js";

export const CONSOLE_LIMIT_MAX = 500;

/** Covers two beacon intervals. */
export const CONSOLE_LISTEN_DEFAULT_S = 120;
/** Below 255-second idle cut. */
export const CONSOLE_LISTEN_MAX_S = 180;
/** Relay timeout margin. */
export const CONSOLE_LISTEN_MARGIN_MS = 15_000;

export const LiveConsoleRequestShape = {
	expr: z
		.string()
		.max(CONSOLE_SOURCE_MAX)
		.optional()
		.describe("An expression to read. Omit it to list every entity and member."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(CONSOLE_LIMIT_MAX)
		.optional()
		.describe("How many items of a list to show. Default 50."),
};

/** Readings follow the first device. */
export const CONSOLE_COMPLETES = [
	"devices",
	"sensors",
	"readings",
	"fields",
	"automations",
	"sources",
	"definitions",
] as const;
export type ConsoleCompletes = (typeof CONSOLE_COMPLETES)[number];

export const ConsoleParamDescriptionSchema = z
	.object({
		name: z.string(),
		type: z.string(),
		description: z.string(),
		optional: z.boolean(),
		completes: z.enum(CONSOLE_COMPLETES).optional(),
	})
	.meta({ id: "ConsoleParamDescription" });

export const ConsoleMemberDescriptionSchema = z
	.object({
		name: z.string(),
		kind: z.enum(["property", "method"]),
		returns: z.string(),
		description: z.string(),
		params: z.array(ConsoleParamDescriptionSchema),
		/** One slow read per request. */
		slow: z.boolean(),
	})
	.meta({ id: "ConsoleMemberDescription" });

export const ConsoleEntityDescriptionSchema = z
	.object({
		name: z.string(),
		description: z.string(),
		catalogue: z.boolean(),
		members: z.array(ConsoleMemberDescriptionSchema),
	})
	.meta({ id: "ConsoleEntityDescription" });

export const ConsoleBuiltinDescriptionSchema = z
	.object({
		name: z.string(),
		/** `none` is called by its name alone. */
		receiver: z.enum(["list", "object", "collection", "none"]),
		params: z.array(
			z
				.object({ name: z.string(), type: z.string(), optional: z.boolean().optional() })
				.meta({ id: "ConsoleBuiltinParam" }),
		),
		returns: z.string(),
		description: z.string(),
	})
	.meta({ id: "ConsoleBuiltinDescription" });

export const ConsoleDescriptionSchema = z
	.object({
		builtins: z.array(ConsoleBuiltinDescriptionSchema),
		entities: z.array(ConsoleEntityDescriptionSchema),
	})
	.meta({ id: "ConsoleDescription" });

const LabelledIdSchema = z.object({ id: z.string(), label: z.string() }).meta({ id: "ConsoleLabelledId" });

/** Never cached; ids move. */
export const ConsoleIdsSchema = z
	.object({
		devices: z.array(
			z
				.object({
					id: z.string(),
					name: z.string(),
					readings: z.array(z.string()),
				})
				.meta({ id: "ConsoleDeviceIds" }),
		),
		fields: z.array(LabelledIdSchema),
		automations: z.array(LabelledIdSchema),
		sources: z.array(LabelledIdSchema),
		definitions: z.array(z.string()),
	})
	.meta({ id: "ConsoleIds" });

export type ConsoleIds = z.infer<typeof ConsoleIdsSchema>;
export type ConsoleEntityDescription = z.infer<typeof ConsoleEntityDescriptionSchema>;
export type ConsoleDescription = z.infer<typeof ConsoleDescriptionSchema>;

const IssueSchema = z
	.object({
		code: z.string(),
		start: z.number().int(),
		end: z.number().int(),
		message: z.string(),
	})
	.meta({ id: "ConsoleIssue" });

const CutSchema = z.object({ shown: z.number().int(), total: z.number().int() }).meta({ id: "ConsoleCut" });

/** Listed numeric keys render as ages. */
export const CONSOLE_INSTANT_KEYS = [
	"at",
	"heardAt",
	"lastAt",
	"firedAt",
	"readAt",
	"lastSuccessAt",
	"nextPollAt",
] as const;
/** Reject second-based timestamps. */
export const CONSOLE_INSTANT_FLOOR = 1e12;
/** JavaScript Date limit. */
export const CONSOLE_INSTANT_CEILING = 8.64e15;

/** Shared protocol byte cap. */
export const CONSOLE_VALUE_BYTES = 64_000;
export const CONSOLE_VARIABLES_MAX = 16;
/** Total saved value byte cap. */
export const CONSOLE_VARIABLES_BYTES = CONSOLE_VALUE_BYTES * 4;

/** Client resends saved values. */
export const ConsoleVariableSchema = z
	.object({ value: z.unknown(), type: z.string().max(64).optional() })
	.meta({ id: "ConsoleVariable" });

export const ConsoleVariablesSchema = z
	.record(z.string().refine(isConsoleVariableName, "not a variable name"), ConsoleVariableSchema)
	.refine((held) => Object.keys(held).length <= CONSOLE_VARIABLES_MAX, "too many variables");

export const ConsoleDescribeResultSchema = z
	.object({ description: ConsoleDescriptionSchema, registryHash: z.string() })
	.meta({ id: "ConsoleDescribeResult" });

export const ConsoleResultItemSchema = z
	.object({
		value: z.unknown(),
		type: z.string().optional(),
		entity: z.string().optional(),
		assigned: z.string().optional(),
		cut: CutSchema.optional(),
	})
	.meta({ id: "ConsoleResultItem" });

export const ConsoleEvalResultSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("ok"), results: z.array(ConsoleResultItemSchema), registryHash: z.string() }),
		z.object({ kind: z.literal("error"), issue: IssueSchema, registryHash: z.string() }),
	])
	.meta({ id: "ConsoleEvalResult" });

export type ConsoleResultItem = z.infer<typeof ConsoleResultItemSchema>;
export type ConsoleDescribeResult = z.infer<typeof ConsoleDescribeResultSchema>;
export type ConsoleEvalResult = z.infer<typeof ConsoleEvalResultSchema>;

export const LiveConsoleAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("ok"),
		text: z.string(),
		registryHash: z.string(),
		cut: CutSchema.optional(),
	}),
	z.object({ kind: z.literal("error"), text: z.string(), issue: IssueSchema }),
	z.object({ kind: z.literal("unauthenticated") }),
	z.object({ kind: z.literal("not_served") }),
]);

export type LiveConsoleAnswer = z.infer<typeof LiveConsoleAnswerSchema>;
