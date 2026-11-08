import { z } from "zod";
import { restoreAgentCatalog } from "./agent-record.js";
import { withTurnMarks } from "./agent-turn-marks.js";
import { CopilotPersistedAgentSchema } from "./copilotAgentRecord.js";

export const CopilotAgentCatalogSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		agents: z.array(CopilotPersistedAgentSchema),
	})
	.strict();
export type CopilotAgentCatalog = z.infer<typeof CopilotAgentCatalogSchema>;

export function restoreCopilotAgentCatalog(raw: unknown): CopilotAgentCatalog | undefined {
	const restored = restoreAgentCatalog(raw, (candidate) => {
		const result = CopilotPersistedAgentSchema.safeParse(withTurnMarks(candidate));
		return result.success ? result.data : undefined;
	});
	if (!restored) return undefined;
	const catalog = CopilotAgentCatalogSchema.safeParse(restored);
	return catalog.success ? catalog.data : undefined;
}
