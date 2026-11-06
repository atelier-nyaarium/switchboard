export const WORKFLOW_AGENT_OUTCOMES = [
	"completed",
	"invalid",
	"failed",
	"interrupted",
	"lost",
	"declined",
	"rejected",
	"unavailable",
] as const;

export type WorkflowAgentOutcome = (typeof WORKFLOW_AGENT_OUTCOMES)[number];
