// The bridge protocol between an OpenCode driver and the process that runs its server.

import { z } from "zod";
import { AgentCounterKindSchema } from "./agent-counter.js";

////////////////////////////////
//  Schemas

const RequestIdSchema = z.string().min(1).max(128);
const ThreadIdSchema = z.string().min(1).max(128);
const TurnIdSchema = z.string().min(1).max(128);
const ItemIdSchema = z.string().min(1).max(256);

export const OpencodeTerminalSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("completed"),
			finalResponse: z.string().optional(),
			finalItemId: z.string().optional(),
		})
		.strict(),
	z.object({ status: z.literal("failed"), error: z.string() }).strict(),
	z.object({ status: z.literal("interrupted"), reason: z.string().optional() }).strict(),
]);
export type OpencodeTerminal = z.infer<typeof OpencodeTerminalSchema>;

export const OpencodeInspectionSchema = z.discriminatedUnion("known", [
	z.object({ known: z.literal("running") }).strict(),
	z.object({ known: z.literal("settled"), terminal: OpencodeTerminalSchema }).strict(),
	z.object({ known: z.literal("unknown") }).strict(),
]);
export type OpencodeInspection = z.infer<typeof OpencodeInspectionSchema>;

export const OpencodeModelSchema = z
	.object({
		id: z.string().min(1).max(256),
	})
	.strict();
export type OpencodeModel = z.infer<typeof OpencodeModelSchema>;

export const BridgeReadySchema = z.discriminatedUnion("ok", [
	z.object({ type: z.literal("ready"), ok: z.literal(true), version: z.string().min(1) }).strict(),
	z
		.object({
			type: z.literal("ready"),
			ok: z.literal(false),
			code: z.enum(["binary_missing", "version_refused", "server_failed"]),
			message: z.string().min(1).max(1024),
		})
		.strict(),
]);
export type BridgeReady = z.infer<typeof BridgeReadySchema>;

const requestBase = {
	type: z.literal("request"),
	id: RequestIdSchema,
};

export const BridgeRequestSchema = z.discriminatedUnion("op", [
	z
		.object({
			...requestBase,
			op: z.literal("open"),
			cwd: z.string().min(1).max(4096),
			/** `provider/model`. */
			model: z.string().min(1).max(256),
		})
		.strict(),
	z
		.object({
			...requestBase,
			op: z.literal("resume"),
			threadId: ThreadIdSchema,
			cwd: z.string().min(1).max(4096),
		})
		.strict(),
	z
		.object({
			...requestBase,
			op: z.literal("start"),
			threadId: ThreadIdSchema,
			turnId: TurnIdSchema,
			prompt: z.string(),
		})
		.strict(),
	z
		.object({
			...requestBase,
			op: z.literal("steer"),
			threadId: ThreadIdSchema,
			turnId: TurnIdSchema,
			promptId: TurnIdSchema,
			prompt: z.string(),
		})
		.strict(),
	z
		.object({
			...requestBase,
			op: z.literal("interrupt"),
			threadId: ThreadIdSchema,
			turnId: TurnIdSchema,
		})
		.strict(),
	z
		.object({
			...requestBase,
			op: z.literal("inspect"),
			threadId: ThreadIdSchema,
			turnId: TurnIdSchema,
		})
		.strict(),
	z.object({ ...requestBase, op: z.literal("models") }).strict(),
]);
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

const resultBase = {
	type: z.literal("result"),
	id: RequestIdSchema,
};

export const BridgeResultSchema = z.discriminatedUnion("op", [
	z.object({ ...resultBase, op: z.literal("open"), threadId: ThreadIdSchema }).strict(),
	z.object({ ...resultBase, op: z.literal("resume") }).strict(),
	z
		.object({
			...resultBase,
			op: z.literal("start"),
			turnId: TurnIdSchema,
			terminal: OpencodeTerminalSchema.optional(),
		})
		.strict(),
	z.object({ ...resultBase, op: z.literal("steer") }).strict(),
	z.object({ ...resultBase, op: z.literal("interrupt"), interrupted: z.boolean() }).strict(),
	z.object({ ...resultBase, op: z.literal("inspect"), inspection: OpencodeInspectionSchema }).strict(),
	z.object({ ...resultBase, op: z.literal("models"), models: z.array(OpencodeModelSchema) }).strict(),
]);
export type BridgeResult = z.infer<typeof BridgeResultSchema>;

export const BridgeErrorCodeSchema = z.enum([
	"bad_request",
	"not_found",
	"model_not_offered",
	"turn_inactive",
	"turn_ended",
	"not_taken",
	"http",
	"closed",
	"protocol",
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BridgeErrorSchema = z
	.object({
		type: z.literal("error"),
		id: RequestIdSchema,
		code: BridgeErrorCodeSchema,
		message: z.string().min(1).max(2048),
	})
	.strict();
export type BridgeError = z.infer<typeof BridgeErrorSchema>;

const eventBase = {
	type: z.literal("event"),
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
};

export const BridgeEventSchema = z.discriminatedUnion("event", [
	z
		.object({
			...eventBase,
			event: z.literal("activity"),
			text: z.string(),
			itemId: ItemIdSchema,
		})
		.strict(),
	z
		.object({
			...eventBase,
			event: z.literal("counter"),
			counterKind: AgentCounterKindSchema,
			itemId: ItemIdSchema.optional(),
		})
		.strict(),
	z
		.object({
			...eventBase,
			event: z.literal("terminal"),
			terminal: OpencodeTerminalSchema,
		})
		.strict(),
	// The turn's server said something.
	z.object({ ...eventBase, event: z.literal("progress") }).strict(),
]);
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const BridgeMessageSchema = z.union([
	BridgeReadySchema,
	BridgeResultSchema,
	BridgeErrorSchema,
	BridgeEventSchema,
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

////////////////////////////////
//  Functions & Helpers

/** `provider/model`, split at the first slash. */
export function splitOpencodeModel(model: string): { providerID: string; id: string } | undefined {
	const at = model.indexOf("/");
	if (at <= 0 || at === model.length - 1) return undefined;
	return { providerID: model.slice(0, at), id: model.slice(at + 1) };
}

/** The prompt with the schema instruction, for an API with no response format. */
export function promptForSchema(prompt: string, schema: Record<string, unknown>): string {
	return `${prompt}\n\nAnswer with one JSON value matching this schema and nothing else:\n${JSON.stringify(schema)}`;
}
