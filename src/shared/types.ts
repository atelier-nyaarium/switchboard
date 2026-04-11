////////////////////////////////
//  Bridge Types

export type ConnectionMode = "cli" | "channel";
export type EffortLevel = "simple" | "standard" | "complex";
export type RequestType = "feature" | "bugfix" | "question";
export type ResponseStatus =
	| "completed"
	| "clarification"
	| "deferred"
	| "needs_human"
	| "error"
	| "timeout"
	| "running";

////////////////////////////////
//  Note: CLI replies (crosstalk_reply) carry a status. Channel replies
//  (channel_reply) are stream messages with no status at all — the fields
//  below are optional so the same payload type serves both paths.

export interface InjectPayload {
	type: "inject";
	from: string;
	request_type: RequestType;
	body: string;
	effort: EffortLevel | "auto";
	session_id: string;
	is_follow_up: boolean;
}

export interface ChannelPushPayload {
	type: "channel_push";
	from: string;
	request_type: RequestType;
	body: string;
	effort: EffortLevel | "auto";
	session_id: string;
	is_follow_up: boolean;
	replyJsonSchema?: string;
	message_id?: string;
}

export interface ResponsePayload {
	session_id: string;
	status?: ResponseStatus;
	response?: string;
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	estimated_minutes?: number;
	what_to_decide?: string;
	message?: string;
}

export interface ResponsePushPayload {
	type: "response_push";
	session_id: string;
	status?: string;
	response?: string;
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	estimated_minutes?: number;
	what_to_decide?: string;
	message?: string;
}

export interface EffortEnv {
	simple?: string;
	standard?: string;
	complex?: string;
}

////////////////////////////////
//  WebSocket Types

export interface RegisterMessage {
	type: "register";
	team: string;
	mode?: ConnectionMode;
	subId?: string;
	conversationId: string;
}

export interface TeamInfo {
	team: string;
	status: "online" | "available";
	mode?: ConnectionMode;
	queue_depth: number;
}

export interface CatalogMessage {
	type: "catalog";
	projects: Array<{ team: string; projectPath: string }>;
}

////////////////////////////////
//  Config Types

export interface ArbiterConfig {
	LOG_PATH: string;
	RESPONSE_TIMEOUT_MS: number;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
}
