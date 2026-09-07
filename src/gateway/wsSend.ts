import type { ServerWebSocket } from "bun";
import type { WsData } from "./wsTypes.js";

export type SendOutcome = "sent" | "queued" | "dropped";

export function sendOn(ws: ServerWebSocket<WsData>, payload: string, label: string): SendOutcome {
	let written: unknown;
	try {
		written = ws.send(payload);
	} catch {
		console.warn(`[ws] ${label} dropped: the socket refused the write`);
		return "dropped";
	}
	// Non-Bun sockets report nothing.
	if (typeof written !== "number") return "sent";
	if (written > 0) return "sent";
	// Negative means buffered.
	if (written < 0) return "queued";
	console.warn(`[ws] ${label} dropped: the socket's buffer is full`);
	return "dropped";
}

export function reached(outcome: SendOutcome): boolean {
	return outcome !== "dropped";
}
