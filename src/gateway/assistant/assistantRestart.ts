// Brings the assistant down once its pane waits on a restart to apply an update; the next wake runs the new build.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { ASSISTANT_SESSION_NAME, ASSISTANT_SPAWN, ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import type { HostOp, HostOpResult, TypeIntoPaneResult } from "../../shared/host-op.js";

/** Lets a message that just arrived land first. */
export const RESTART_GRACE_MS = 30_000;

export interface AssistantRestartDeps {
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	/** A routine run, check-in or agent turn the exit would cut off. */
	busy: () => boolean;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
}

export interface AssistantRestart {
	/** What the daemon reads off a session's pane. */
	seen(team: string, pending: boolean): void;
	stop(): void;
}

export function createAssistantRestart(deps: AssistantRestartDeps): AssistantRestart {
	let timer: TimerHandle | undefined;
	let attempt = 0;
	let stopped = false;

	const cancel = () => {
		if (timer !== undefined) deps.ambient.clearTimer(timer);
		timer = undefined;
	};

	const schedule = () => {
		cancel();
		if (!stopped) timer = deps.ambient.setTimer(() => void tryExit(), RESTART_GRACE_MS);
	};

	/** Typed delivery refuses a working pane or a filled composer, so `/exit` lands only on an idle one. */
	async function tryExit(): Promise<void> {
		timer = undefined;
		if (deps.busy()) return schedule();
		attempt += 1;
		let relayed: HostOpResult;
		try {
			relayed = await deps.relayToHost({
				kind: "typeIntoPane",
				target: { kind: "host", name: ASSISTANT_SPAWN, sessionName: ASSISTANT_SESSION_NAME },
				text: "/exit",
				dedupKey: `assistant-restart:${attempt}`,
			});
		} catch {
			return schedule();
		}
		const outcome = relayed.ok ? (relayed.result as TypeIntoPaneResult | undefined) : undefined;
		if (outcome?.typed === true) {
			console.error("[assistant] exited to apply an installed update");
			return;
		}
		schedule();
	}

	return {
		seen(team, pending) {
			if (team !== ASSISTANT_TEAM) return;
			if (pending && timer === undefined) schedule();
			if (!pending) cancel();
		},
		stop() {
			stopped = true;
			cancel();
		},
	};
}
