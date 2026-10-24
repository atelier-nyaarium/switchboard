// The assistant's one session. A name is not a binding, so provenance decides, as for a routine.

import { ASSISTANT_ACTION_KEYS } from "./schemasAssistantActions.js";
import { ASSISTANT_COMMANDS } from "./session-commands.js";
import { composeSessionName } from "./session-id.js";
import { ASSISTANT_ROLE } from "./wire-vocabulary.js";

export const ASSISTANT_SPAWN = "host";
export const ASSISTANT_SESSION_NAME = "assistant";
export const ASSISTANT_TEAM = composeSessionName(ASSISTANT_SPAWN, ASSISTANT_SESSION_NAME);

/** `createSession` provenance shape: `${conversationId}:${opId}`. */
export const ASSISTANT_RESERVE_KEY = "assistant:reserve";

export const SWITCHBOARD_TOOL_PREFIX = "mcp__plugin_switchboard_switchboard__";

/** The channel tools every session has. */
export const ASSISTANT_REPLY_TOOLS = {
	reply: "channel_reply",
	replyStructured: "channel_reply_structured",
	capabilities: "switchboard_capabilities",
	notify: "notify_human",
} as const;

/** Its crosstalk; collect and withdraw are its alone. */
export const ASSISTANT_CROSSTALK_TOOLS = {
	discover: "crosstalk_discover",
	send: "crosstalk_send",
	wait: "crosstalk_wait",
	collect: "crosstalk_collect",
	withdraw: "crosstalk_withdraw",
} as const;

/** Switchboard tools the assistant may call. */
export const ASSISTANT_SWITCHBOARD_TOOLS: readonly string[] = [
	...Object.values(ASSISTANT_REPLY_TOOLS),
	...Object.values(ASSISTANT_COMMANDS).map(({ tool }) => tool),
	...ASSISTANT_ACTION_KEYS,
	...Object.values(ASSISTANT_CROSSTALK_TOOLS),
];

/** Every built-in the assistant's session has. `ToolSearch` loads a deferred tool's schema. */
export const ASSISTANT_BUILTIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "ToolSearch"] as const;

export type AssistantBuiltinTool = (typeof ASSISTANT_BUILTIN_TOOLS)[number];

/** Provisioned by the Gateway, not merely sharing the name. */
export function isAssistantRecord(record: { spawn: string; id: string; mintedFrom?: string } | undefined): boolean {
	return (
		record !== undefined &&
		record.spawn === ASSISTANT_SPAWN &&
		record.id === ASSISTANT_SESSION_NAME &&
		record.mintedFrom === ASSISTANT_RESERVE_KEY
	);
}

/** Rows a session may see: the assistant's stamped row is the owner's alone. */
export function ordinaryRows<T extends { role?: string }>(rows: readonly T[]): T[] {
	return rows.filter((row) => row.role !== ASSISTANT_ROLE);
}
