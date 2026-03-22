import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import type { ChannelPushPayload } from "../../shared/types.js";
import type { WsData } from "../websocket.js";
import { validateMessageParts } from "./validateMessageParts.js";

////////////////////////////////
//  Interfaces & Types

export type TeamRegistry = Map<string, Map<string, ServerWebSocket<WsData>>>;

export interface DiscordRelayDeps {
	registry: TeamRegistry;
}

export interface DiscordRelay {
	sendDM: (parts: string[], retryCount?: number) => Promise<SendDMResult>;
	stop: () => Promise<void>;
}

export interface SendDMSuccess {
	success: true;
	partsSent: number;
}

export interface SendDMValidationFailure {
	success: false;
	valid: false;
	error: string;
	totalLength: number;
	suggestedParts: number;
	violations: Array<{ index: number; length: number }>;
	guidelines: string[];
}

export interface SendDMError {
	success: false;
	error: string;
}

export type SendDMResult = SendDMSuccess | SendDMValidationFailure | SendDMError;

////////////////////////////////
//  Functions & Helpers

function getAllActiveWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	const result: ServerWebSocket<WsData>[] = [];
	for (const [, ws] of subs) {
		if (ws.readyState === 1) result.push(ws);
	}
	return result;
}

export async function startDiscordRelay({ registry }: DiscordRelayDeps): Promise<DiscordRelay> {
	const secretKey = process.env.DISCORD_SECRET_KEY!;
	const ownerId = process.env.DISCORD_OWNER_ID!;

	if (!secretKey || !ownerId) {
		throw new Error(`DISCORD_SECRET_KEY and DISCORD_OWNER_ID are required for Discord relay`);
	}

	const client = new Client({
		intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions],
		partials: [Partials.Channel],
	});

	client.on(Events.MessageCreate, (message) => {
		// Ignore bots, system messages, and non-DM messages
		if (message.author.bot || message.author.system) return;
		if (message.guildId) return;

		// Only accept messages from the configured owner
		if (message.author.id !== ownerId) return;

		const sessionId = crypto.randomUUID();
		const orchestratorSubs = registry.get("__orchestrator__");

		if (!orchestratorSubs) {
			console.error(`[discord] no __orchestrator__ registered, dropping DM from ${message.author.tag}`);
			return;
		}

		const activeWs = getAllActiveWs(orchestratorSubs);
		if (activeWs.length === 0) {
			console.error(`[discord] __orchestrator__ has no active connections, dropping DM`);
			return;
		}

		const payload: ChannelPushPayload = {
			type: "channel_push",
			from: "discord",
			request_type: "question",
			body: message.content,
			effort: "standard",
			session_id: sessionId,
			is_follow_up: false,
		};

		const serialized = JSON.stringify(payload);
		for (const ws of activeWs) {
			ws.send(serialized);
		}

		console.log(`[discord] DM from ${message.author.tag} → __orchestrator__ [${sessionId.slice(0, 8)}...]`);
	});

	await client.login(secretKey);
	console.log(`[discord] logged in as ${client.user?.tag}`);

	async function sendDM(parts: string[], retryCount = 0): Promise<SendDMResult> {
		const validation = validateMessageParts({ parts, retryCount });

		if (!validation.valid) {
			return {
				success: false,
				valid: false,
				error: validation.error,
				totalLength: validation.totalLength,
				suggestedParts: validation.suggestedParts,
				violations: validation.violations,
				guidelines: validation.guidelines,
			};
		}

		try {
			const user = await client.users.fetch(ownerId);
			const dmChannel = await user.createDM();

			for (let i = 0; i < parts.length; i++) {
				const isLast = i === parts.length - 1;
				await dmChannel.send({
					content: parts[i],
					flags: isLast ? undefined : MessageFlags.SuppressEmbeds,
				});
			}

			return { success: true, partsSent: parts.length };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[discord] sendDM failed: ${message}`);
			return { success: false, error: `Failed to send DM: ${message}` };
		}
	}

	async function stop(): Promise<void> {
		client.destroy();
		console.log(`[discord] client destroyed`);
	}

	return { sendDM, stop };
}
