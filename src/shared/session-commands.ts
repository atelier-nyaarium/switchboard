// What a session can be told to do, declared once. A nudge names a command from here rather than
// spelling a tool name, so prose cannot ask for something that was never built.

import type { z } from "zod";
import {
	SessionReportAnswerSchema,
	SessionReportRequestShape,
	SessionRoutineAnswerSchema,
	SessionRoutineRequestShape,
} from "./schemasRoutine.js";

export interface SessionCommand {
	/** The MCP tool a session calls. */
	tool: string;
	/** The gateway's loopback path behind it. */
	path: string;
	/** A shape, so the tool's input schema and the route's parse cannot drift apart. */
	request: z.ZodRawShape;
	answer: z.ZodType;
}

/**
 * One entry per command. Both sides read it: the MCP registers every tool named here, and the
 * gateway serves every path. A command with only one half is a build error rather than a session
 * being told to call something that answers nothing.
 */
export const SESSION_COMMANDS = {
	sessionRoutine: {
		tool: "get_session_routine",
		path: "/routine/session",
		request: SessionRoutineRequestShape,
		answer: SessionRoutineAnswerSchema,
	},
	sessionReport: {
		tool: "report_session_routine",
		path: "/routine/report",
		request: SessionReportRequestShape,
		answer: SessionReportAnswerSchema,
	},
} as const satisfies Record<string, SessionCommand>;

export type SessionCommandId = keyof typeof SESSION_COMMANDS;
