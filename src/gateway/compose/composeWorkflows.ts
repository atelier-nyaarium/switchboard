import type { Ambient } from "../../shared/ambient.js";
import {
	createWorkflowEngine,
	type WorkflowDispatchPort,
	type WorkflowEngine,
	type WorkflowThreadAdoptionPort,
} from "../workflows/engine.js";
import { createWorkflowRunner, type WorkflowAgentRetirement, type WorkflowRunner } from "../workflows/runner.js";
import { createWorkflowRunStore, type WorkflowRunStore } from "../workflows/store.js";

export interface WorkflowsStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "newId">;
	retireAgents?: WorkflowAgentRetirement;
	dispatch?: WorkflowDispatchPort;
	threadAdoption?: WorkflowThreadAdoptionPort;
}

export interface WorkflowsStage {
	store: WorkflowRunStore;
	runner: WorkflowRunner;
	engine: WorkflowEngine;
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
	const engine = createWorkflowEngine({
		runner,
		ambient: deps.ambient,
		dispatch: deps.dispatch ?? { dispatch: () => {} },
		...(deps.threadAdoption ? { threadAdoption: deps.threadAdoption } : {}),
	});
	return {
		store,
		runner,
		engine,
		start: () => engine.start(),
		stop: () => {
			engine.stop();
			runner.stop();
		},
		sweep: () => runner.sweep(),
	};
}
