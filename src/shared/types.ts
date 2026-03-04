export type EffortLevel = "simple" | "standard" | "complex";
export type RequestType = "feature" | "bugfix" | "question";
export type ResponseStatus = "completed" | "clarification" | "deferred" | "needs_human" | "error" | "timeout";

export interface InjectPayload {
	type: "inject";
	from: string;
	request_type: RequestType;
	body: string;
	effort: EffortLevel | "auto";
	session_id: string;
	is_follow_up: boolean;
}

export interface RegisterMessage {
	type: "register";
	team: string;
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

export interface PendingEntry {
	resolve: (value: ResponsePayload) => void;
	timer: ReturnType<typeof setTimeout>;
	from: string;
	to: string;
}

export interface TeamInfo {
	team: string;
	status: "active";
	queue_depth: number;
}

export interface EffortEnv {
	simple: string;
	standard: string;
	complex: string;
}

export interface ArbiterConfig {
	LOG_PATH: string;
	RESPONSE_TIMEOUT_MS: number;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
}
