// The assistant's one session. A name is not a binding, so provenance decides, as for a routine.

import { ASSISTANT_ACTION_KEYS } from "./schemasAssistantActions.js";
import { ASSISTANT_COMMANDS } from "./session-commands.js";
import { composeSessionName } from "./session-id.js";

export const ASSISTANT_SPAWN = "host";
export const ASSISTANT_SESSION_NAME = "assistant";
export const ASSISTANT_TEAM = composeSessionName(ASSISTANT_SPAWN, ASSISTANT_SESSION_NAME);

/** `createSession` provenance shape: `${conversationId}:${opId}`. */
export const ASSISTANT_RESERVE_KEY = "assistant:reserve";

export const SWITCHBOARD_TOOL_PREFIX = "mcp__plugin_switchboard_switchboard__";

/** Switchboard tools the assistant may call. */
export const ASSISTANT_SWITCHBOARD_TOOLS: readonly string[] = [
	"channel_reply",
	"channel_reply_structured",
	"switchboard_capabilities",
	"notify_human",
	ASSISTANT_COMMANDS.inbox.tool,
	...ASSISTANT_ACTION_KEYS,
];

/** Every built-in the assistant's session has. `ToolSearch` loads a deferred tool's schema. */
export const ASSISTANT_BUILTIN_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "ToolSearch"];

/** Provisioned by the Gateway, not merely sharing the name. */
export function isAssistantRecord(record: { spawn: string; id: string; mintedFrom?: string } | undefined): boolean {
	return (
		record !== undefined &&
		record.spawn === ASSISTANT_SPAWN &&
		record.id === ASSISTANT_SESSION_NAME &&
		record.mintedFrom === ASSISTANT_RESERVE_KEY
	);
}
