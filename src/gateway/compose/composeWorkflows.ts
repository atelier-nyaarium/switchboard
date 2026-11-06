import type { Ambient } from "../../shared/ambient.js";
import { createWorkflowRunner, type WorkflowAgentRetirement, type WorkflowRunner } from "../workflows/runner.js";
import { createWorkflowRunStore, type WorkflowRunStore } from "../workflows/store.js";

export interface WorkflowsStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "newId">;
	retireAgents?: WorkflowAgentRetirement;
}

export interface WorkflowsStage {
	store: WorkflowRunStore;
	runner: WorkflowRunner;
	start: () => boolean;
	stop: () => void;
	sweep: () => number;
}

export function composeWorkflows(deps: WorkflowsStageDeps): WorkflowsStage {
	const store = createWorkflowRunStore(deps.dataDir, deps.ambient);
	const runner = createWorkflowRunner({
		store,
		ambient: deps.ambient,
		...(deps.retireAgents ? { retireAgents: deps.retireAgents } : {}),
	});
	return {
		store,
		runner,
		start: () => runner.start(),
		stop: () => runner.stop(),
		sweep: () => runner.sweep(),
	};
}
