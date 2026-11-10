import type { z } from "zod";
import type { NoticeTierWire } from "./notice.js";
import type {
	ChannelFileSchema,
	ConnectionModeSchema,
	GatewaySpawnPointsSchema,
	ResponseStatusSchema,
	TeamInfoSchema,
	TeamKindSchema,
} from "./schemas.js";

////////////////////////////////
//  Bridge Types

/** A `blobId` names staged bytes; absent means metadata only. */
export type ChannelFile = z.infer<typeof ChannelFileSchema>;

export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;
export type ResponseStatus = z.infer<typeof ResponseStatusSchema>;

/** `no_act` rides the next message; `act_now` is pushed alone if none comes in time. */
export type ActAxis = "no_act" | "act_now";

/** Banked notices, riding a message or pushed alone. `from` names the sources. */
export interface RidingAwareness {
	from: string;
	body: string;
	act: ActAxis;
}

// Optional; absent asks by default.
export const REPLY_DISPOSITIONS = ["asking", "informing", "closing"] as const;
export type ReplyDisposition = (typeof REPLY_DISPOSITIONS)[number];

export function isReplyDisposition(value: unknown): value is ReplyDisposition {
	return REPLY_DISPOSITIONS.some((known) => known === value);
}

/** Who reads a reply. Only a phone's carries spoken tiers. */
export const REPLY_READERS = ["phone", "session"] as const;
export type ReplyReader = (typeof REPLY_READERS)[number];

////////////////////////////////
//  Reply payloads; a stream message may carry a partial update.

export const MAX_PENDING_DELIVERIES = 2_000;

export interface ChannelPushPayload {
	type: "channel_push";
	from: string;
	body: string;
	session_id: string;
	replyJsonSchema?: string;
	message_id?: string;
	files?: ChannelFile[];
	// Awareness only; the gateway still absorbs a reply that comes anyway.
	no_ack?: boolean;
	// Only ever set beside no_ack.
	act?: ActAxis;
	// Rendered as a reminder block.
	awareness?: RidingAwareness;
	disposition?: ReplyDisposition;
	/** The owner approved this message on their phone before it was sent. */
	owner_approved?: boolean;
	/** Absent when the Gateway does not know. */
	reader?: ReplyReader;
	/** A watcher event: data only, with no sender, conversation or reply owed. */
	event?: boolean;
	/** Receiver acks stored id; untracked pushes omit it. */
	delivery_id?: string;
}

export interface ResponsePayload extends NoticeTierWire {
	session_id: string;
	status?: ResponseStatus;
	/** The address the message went to, a minted one included. */
	target?: string;
	response?: string;
	replyAsJson?: Record<string, unknown>;
	question?: string;
	reason?: string;
	estimated_minutes?: number;
	what_to_decide?: string;
	message?: string;
	files?: ChannelFile[];
}

export interface ResponsePushPayload {
	type: "response_push";
	session_id: string;
	status?: string;
	response?: string;
	message_id?: string;
	files?: ChannelFile[];
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

/** Devcontainer teams are wakeable; loose teams end with their process. */
export type TeamKind = z.infer<typeof TeamKindSchema>;

export type TeamInfo = z.infer<typeof TeamInfoSchema>;
export type GatewaySpawnPoints = z.infer<typeof GatewaySpawnPointsSchema>;

export interface CatalogMessage {
	type: "catalog";
	projects: Array<{ team: string; projectPath: string }>;
}

////////////////////////////////
//  Config Types

export interface GatewayConfig {
	localGatewayId: string;
	localDomainId: string;
}

export interface WebSocketConfig {
	HEARTBEAT_INTERVAL_MS: number;
	MISSED_PINGS_LIMIT: number;
	// When set, the "host" team's register must present it.
	hostWsToken?: string;
}
