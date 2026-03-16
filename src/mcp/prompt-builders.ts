////////////////////////////////
//  Interfaces & Types

export interface InjectMessage {
	from: string;
	request_type: string;
	body: string;
}

////////////////////////////////
//  Functions & Helpers

export function buildInitialPrompt(msg: InjectMessage, replyProxyPort: number, sessionId: string): string {
	return `
┃ CROSS-TEAM COMMUNICATION - USE SKILL: agent-team-bridge - **Receiving a Request**
┃ From: ${msg.from}
┃ Type: ${msg.request_type}
┃ session_id: ${sessionId}
┃ ↳ When finished, call bridge_reply with the session_id above.
┃ If you do NOT have the bridge_reply MCP tool (e.g. CLI agent), submit your reply by POSTing JSON to:
┃   http://127.0.0.1:${replyProxyPort}/respond
┃ Body: { "session_id": "${sessionId}", "status": "completed"|"clarification"|"deferred"|"needs_human", ... }
┃ Example (completed): curl -s -X POST http://127.0.0.1:${replyProxyPort}/respond -H "Content-Type: application/json" -d '{"session_id":"${sessionId}","status":"completed","response":"Your answer here"}'

${msg.body}
`.trim();
}

export function buildFollowUpPrompt(msg: InjectMessage, replyProxyPort: number, sessionId: string): string {
	return `
┃ CROSS-TEAM COMMUNICATION - USE SKILL: agent-team-bridge - **Receiving a Follow-up**
┃ From: ${msg.from}
┃ session_id: ${sessionId}
┃ ↳ When finished, call bridge_reply with the session_id above.
┃ If you do NOT have bridge_reply, POST your reply to: http://127.0.0.1:${replyProxyPort}/respond (session_id: ${sessionId})

${msg.body}
`.trim();
}
