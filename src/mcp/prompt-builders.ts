////////////////////////////////
//  Interfaces & Types

export interface InjectMessage {
	from: string;
	request_type: string;
	body: string;
}

////////////////////////////////
//  Functions & Helpers

export function buildInitialPrompt(msg: InjectMessage, sessionId: string): string {
	return `
┃ CROSS-TEAM COMMUNICATION - USE SKILL: crosstalk - **Receiving a Request**
┃ From: ${msg.from}
┃ Type: ${msg.request_type}
┃ session_id: ${sessionId}
┃ ↳ When finished, call crosstalk_reply with the session_id above.

${msg.body}
`.trim();
}

export function buildFollowUpPrompt(msg: InjectMessage, sessionId: string): string {
	return `
┃ CROSS-TEAM COMMUNICATION - USE SKILL: crosstalk - **Receiving a Follow-up**
┃ From: ${msg.from}
┃ session_id: ${sessionId}
┃ ↳ When finished, call crosstalk_reply with the session_id above.

${msg.body}
`.trim();
}
