// The assistant's one session: provisioned once, reserved from both sweeps, never forgotten.

import {
	ASSISTANT_RESERVE_KEY,
	ASSISTANT_SESSION_NAME,
	ASSISTANT_SPAWN,
	ASSISTANT_TEAM,
	isAssistantRecord,
} from "../../shared/assistant-session.js";
import { isSpawnWorkdirPath } from "../../shared/host-op.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AssistantStageDeps {
	/** Unset means no assistant, and its record is an ordinary one. */
	workdir: string | undefined;
	sessions: Pick<SessionsStage, "sessionStore" | "presence">;
}

export interface AssistantStage {
	/** Whether that session is the assistant's, which no sweep takes. */
	reserves: (team: string) => boolean;
	/** The refusal reason, or null. */
	forgetRefusal: (team: string) => string | null;
}

export function composeAssistant({ workdir, sessions }: AssistantStageDeps): AssistantStage {
	const configured = workdir !== undefined && provision(workdir, sessions);
	const isAssistant = (team: string) =>
		configured && team === ASSISTANT_TEAM && isAssistantRecord(sessions.sessionStore.getByTeam(team));
	return {
		reserves: isAssistant,
		forgetRefusal: (team) => (isAssistant(team) ? "the assistant's session is never forgotten" : null),
	};
}

/**
 * Mints the record only. The first wake launches it, so a Gateway booting before its host connects
 * still provisions.
 */
function provision(workdir: string, sessions: AssistantStageDeps["sessions"]): boolean {
	if (!isSpawnWorkdirPath(ASSISTANT_SPAWN, workdir)) {
		console.error(`[assistant] ASSISTANT_WORKDIR "${workdir}" is not an absolute or ~-rooted path`);
		return false;
	}
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held) {
		if (!isAssistantRecord(held)) {
			console.error(`[assistant] ${ASSISTANT_TEAM} is held by a session the assistant did not make`);
			return false;
		}
		// The configured workdir governs, never a stored one.
		if (held.workdirPath !== workdir) {
			console.log(`[assistant] ${ASSISTANT_TEAM} workdir ${held.workdirPath ?? "unset"} -> ${workdir}`);
			held.workdirPath = workdir;
		}
		return true;
	}
	const minted = sessions.presence.adoptById(ASSISTANT_SESSION_NAME, {
		spawn: ASSISTANT_SPAWN,
		sessionLabel: "Assistant",
		workdirHint: "Assistant",
		workdirPath: workdir,
		mintedFrom: ASSISTANT_RESERVE_KEY,
	});
	if (!minted) {
		console.error(`[assistant] cannot claim ${ASSISTANT_TEAM}: the name is reserved or a project`);
		return false;
	}
	console.log(`[assistant] provisioned ${ASSISTANT_TEAM} in ${workdir}`);
	return true;
}
