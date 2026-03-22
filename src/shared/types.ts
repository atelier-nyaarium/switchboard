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
}

export interface ResponsePayload {
	session_id: string;
	status: ResponseStatus;
	response?: string;
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
