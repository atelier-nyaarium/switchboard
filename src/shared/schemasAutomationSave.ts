// Saving an automation with the function it runs, and why a save is refused.

import { z } from "zod";
import { AUTOMATIONS_MAX } from "./schemasAutomation.js";

export const AUTOMATION_SAVE_REFUSALS = [
	/** `record`, `revision` held now. */
	"moved",
	/** `record`. */
	"gone",
	/** `kind`, `max`. */
	"full",
	/** `record`, `path`. */
	"invalid",
	/** `record`, `path`, `param`, `start`, `end`. */
	"hole",
	/** `automations` that stop fitting. */
	"unfit",
	/** `id`. */
	"unknown_function",
	"mixed",
	"newer_app",
	"not_home",
	/** `labels` to confirm. */
	"confirm",
	/** Trigger has its own cool-down. */
	"cool_down_twice",
] as const;
export type AutomationSaveRefusalCode = (typeof AUTOMATION_SAVE_REFUSALS)[number];

export const SAVE_RECORDS = ["automation", "function"] as const;

export const AutomationSaveRefusalSchema = z
	.object({
		code: z.enum(AUTOMATION_SAVE_REFUSALS),
		record: z.enum(SAVE_RECORDS).optional(),
		revision: z.number().int().nonnegative().optional(),
		kind: z.enum(SAVE_RECORDS).optional(),
		max: z.number().int().positive().optional(),
		path: z.string().max(64).optional(),
		param: z.string().max(32).optional(),
		start: z.number().int().nonnegative().optional(),
		end: z.number().int().nonnegative().optional(),
		automations: z.array(z.string()).max(AUTOMATIONS_MAX).optional(),
		labels: z.array(z.string().max(80)).max(32).optional(),
		id: z.string().optional(),
	})
	.meta({ id: "AutomationSaveRefusal" });
export type AutomationSaveRefusal = z.infer<typeof AutomationSaveRefusalSchema>;
