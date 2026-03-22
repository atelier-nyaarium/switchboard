import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";

////////////////////////////////
//  Interfaces & Types

export interface ClientData {
	shortHash: string;
}

export interface ClientSession {
	shortHash: string;
	ws: ServerWebSocket<ClientData>;
	connectedAt: Date;
	remoteAddress: string;
}

////////////////////////////////
//  State

const clients = new Map<string, ClientSession>();

////////////////////////////////
//  Functions & Helpers

function generateShortHash(): string {
	for (let i = 0; i < 10; i++) {
		const hash = randomUUID().replace(/-/g, "").slice(0, 6);
		if (!clients.has(hash)) return hash;
	}
	throw new Error(`Failed to generate unique short hash after 10 attempts`);
}

export function addClient(ws: ServerWebSocket<ClientData>, remoteAddress: string): ClientSession {
	const shortHash = generateShortHash();
	ws.data.shortHash = shortHash;
	const session: ClientSession = {
		shortHash,
		ws,
		connectedAt: new Date(),
		remoteAddress,
	};
	clients.set(shortHash, session);
	return session;
}

export function removeClient(shortHash: string): void {
	clients.delete(shortHash);
}

export function getClient(shortHash: string): ClientSession | undefined {
	return clients.get(shortHash);
}

export function getAllClients(): ClientSession[] {
	return Array.from(clients.values());
}
