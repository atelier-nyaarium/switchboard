// The one door a routine's own session reaches, and the only road to a stored snapshot.

import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import type { Occurrence } from "./occurrences.js";
import { answerSessionRoutine } from "./sessionRoutine.js";

const COMMAND = SESSION_COMMANDS.sessionRoutine;

export type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface RoutineRoutesDeps {
	/** The team the caller's token resolves to, or null when it resolves to nothing. */
	resolveCaller: (req: Request) => string | null;
	occurrences: () => Occurrence[];
	routineName: (routineId: string) => string | null;
	/** Records that the session read its instructions, which is the other half of liveness. */
	noteRead: (routineId: string, scheduledAt: number) => void;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createRoutineRoutes(deps: RoutineRoutesDeps): Map<string, Handler> {
	// The four outcomes are the answer's `kind`, and a status would encode the same thing twice.
	const sessionRoutine: Handler = async (req, body) => {
		const parsed = COMMAND.request.safeParse(body);
		if (!parsed.success) return json({ error: "an occurrence id is required" }, 400);
		const answer = answerSessionRoutine(
			{
				callerTeam: () => deps.resolveCaller(req),
				occurrences: deps.occurrences,
				routineName: deps.routineName,
			},
			parsed.data.occurrenceId,
		);
		if (answer.kind === "instructions") deps.noteRead(answer.routineId, answer.scheduledAt);
		return json(answer, 200);
	};

	return new Map<string, Handler>([[COMMAND.path, sessionRoutine]]);
}
