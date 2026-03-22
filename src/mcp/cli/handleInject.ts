import type { EffortEnv, InjectPayload } from "../../shared/types.js";
import { routerPost } from "../bridge/helpers.js";
import { resolveModel } from "../resolve-model.js";
import { CLI_AGENT_HANDLERS } from "./agentHandlers.js";
import { buildFollowUpPrompt, buildInitialPrompt } from "./promptBuilders.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Handle an inject message from the arbiter for CLI (run-and-quit) agents.
 * Spawns a CLI agent process, sends the prompt, and waits for it to finish.
 * The spawned agent must call crosstalk_reply to close the loop.
 */
export async function handleInject(msg: InjectPayload, agentType: string, effortEnv: EffortEnv): Promise<void> {
	const sessionId = msg.session_id;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		console.error(`[bridge] inject missing session_id; router must send it`);
		return;
	}

	const handler = CLI_AGENT_HANDLERS[agentType];
	if (!handler) {
		console.error(`[bridge] unknown CLI agent type: "${agentType}"`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: `Agent type "${agentType}" is not a recognized CLI handler. Valid types: ${Object.keys(CLI_AGENT_HANDLERS).join(", ")}`,
		}).catch(() => {});
		return;
	}

	try {
		const model = resolveModel(msg.effort, { effortEnv, agentType });
		const isFollowUp = !!msg.is_follow_up;
		const agentSessionId = isFollowUp ? sessionId : await handler.createSession(sessionId);

		const prompt = isFollowUp ? buildFollowUpPrompt(msg, sessionId) : buildInitialPrompt(msg, sessionId);

		console.error(
			`[bridge] ${isFollowUp ? "follow-up" : "new"} ${agentType}/${model} session ${sessionId.slice(0, 8)}... from ${msg.from}`,
		);

		await handler.sendMessage(agentSessionId, prompt, model, isFollowUp);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[bridge] inject failed: ${message}`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: message,
		}).catch(() => {});
	}
}
