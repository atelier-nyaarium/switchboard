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
	buildDispatch?: (runner: WorkflowRunner) => {
		port: WorkflowDispatchPort;
		retireRun: WorkflowAgentRetirement;
		inspectThread: NonNullable<WorkflowThreadAdoptionPort["inspect"]>;
		retagThread: NonNullable<WorkflowThreadAdoptionPort["retag"]>;
	};
}

export interface WorkflowsStage {
	store: WorkflowRunStore;
	runner: WorkflowRunner;
	engine: WorkflowEngine;
	start: () => boolean;
	stop: () => void;
	sweep: () => number;
	forgetSession: (team: string) => void;
	reserves: (team: string) => boolean;
	hostRegistering: () => void;
	hostRegistered: () => void;
	catalogChanged: () => void;
}

export function composeWorkflows(deps: WorkflowsStageDeps): WorkflowsStage {
	const store = createWorkflowRunStore(deps.dataDir, deps.ambient);
	let built: ReturnType<NonNullable<WorkflowsStageDeps["buildDispatch"]>> | undefined;
	const runner = createWorkflowRunner({
		store,
		ambient: deps.ambient,
		retireAgents: (run) => built?.retireRun(run) ?? deps.retireAgents?.(run) ?? true,
	});
	built = deps.buildDispatch?.(runner);
	const engine = createWorkflowEngine({
		runner,
		ambient: deps.ambient,
		dispatch: built?.port ?? deps.dispatch ?? { dispatch: () => {} },
		...(built
			? { threadAdoption: { inspect: built.inspectThread, retag: built.retagThread } }
			: deps.threadAdoption
				? { threadAdoption: deps.threadAdoption }
				: {}),
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
		forgetSession: (team) => engine.forgetSession(team),
		reserves: (team) => engine.reserves(team),
		hostRegistering: () => engine.hostRegistering(),
		hostRegistered: () => engine.hostRegistered(),
		catalogChanged: () => engine.catalogChanged(),
	};
}
