import type { Ambient } from "../../shared/ambient.js";
import type { ClaudeTurnResultFrame } from "../../shared/host-op.js";
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
	onChanged?: (team: string) => void;
	buildDispatch?: (runner: WorkflowRunner) => {
		port: WorkflowDispatchPort;
		retireRun: WorkflowAgentRetirement;
		expireClaudeThreads: () => number;
		claudeTurnResult: (frame: ClaudeTurnResultFrame) => Promise<void>;
		inspectThread: NonNullable<WorkflowThreadAdoptionPort["inspect"]>;
		retagThread: NonNullable<WorkflowThreadAdoptionPort["retag"]>;
		watchThread: WorkflowThreadAdoptionPort["watch"];
	};
}

export interface WorkflowsStage {
	store: WorkflowRunStore;
	runner: WorkflowRunner;
	engine: WorkflowEngine;
	start: () => boolean;
	stop: () => void;
	sweep: () => number;
	expireClaudeThreads: () => number;
	forgetSession: (team: string) => void;
	reserves: (team: string) => boolean;
	hostRegistering: () => void;
	hostRegistered: () => void;
	catalogChanged: () => void;
	claudeTurnResult: (frame: ClaudeTurnResultFrame) => Promise<void>;
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
		onChanged: deps.onChanged,
		...(built
			? { threadAdoption: { inspect: built.inspectThread, retag: built.retagThread, watch: built.watchThread } }
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
		expireClaudeThreads: () => built?.expireClaudeThreads() ?? 0,
		forgetSession: (team) => engine.forgetSession(team),
		reserves: (team) => engine.reserves(team),
		hostRegistering: () => engine.hostRegistering(),
		hostRegistered: () => engine.hostRegistered(),
		catalogChanged: () => engine.catalogChanged(),
		claudeTurnResult: (frame) =>
			built ? built.claudeTurnResult(frame) : Promise.reject(new Error("workflow dispatch unavailable")),
	};
}
