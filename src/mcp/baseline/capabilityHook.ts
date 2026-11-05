// Compact capability guidance hook.

import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { neutralizeMarkup } from "../../shared/system-reminder.js";
import { readStartupCapabilities } from "../capabilities.js";
import { capabilityGuidance } from "../capabilitiesTool.js";
import { gatewayBase, type HookEnv } from "../hookGateway.js";

/** Under Claude Code's 10,000. */
export const MAX_GUIDANCE_CHARS = 9_000;

const UNAVAILABLE = `Switchboard capability guidance could not be read. \`switchboard_capabilities\` serves it.`;

/** Cuts at a section boundary. */
export function fitGuidance(text: string): string {
	if (text.length <= MAX_GUIDANCE_CHARS) return text;
	const note = `\n\ntruncated: \`switchboard_capabilities\` has the rest.`;
	const room = text.slice(0, MAX_GUIDANCE_CHARS - note.length);
	const cut = room.lastIndexOf("\n## ");
	return `${cut > 0 ? room.slice(0, cut) : room}${note}`;
}

export interface CapabilityHookDeps {
	guidance?: typeof capabilityGuidance;
	startup?: typeof readStartupCapabilities;
}

/** The hook's stdout. Never throws. */
export async function capabilityHookOutput(env: HookEnv, deps: CapabilityHookDeps = {}): Promise<string> {
	const guidance = deps.guidance ?? capabilityGuidance;
	const assistant = env.PROJECT_NAME === ASSISTANT_TEAM;
	const startup = assistant ? null : (deps.startup ?? readStartupCapabilities)(env.PROJECT_NAME);
	const text = await guidance({ assistant, startup }, gatewayBase(env)).catch(() => null);
	const context = fitGuidance(neutralizeMarkup(text ?? UNAVAILABLE));
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}
