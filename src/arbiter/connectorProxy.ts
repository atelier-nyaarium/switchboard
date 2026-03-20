import type { ServerWebSocket } from "bun";
import type { WsData } from "./websocket.js";

const upstreamMap = new Map<ServerWebSocket<WsData>, WebSocket>();

export function setupProxy(clientWs: ServerWebSocket<WsData>, project: string, authHeader: string): void {
	const url = `ws://${project}:20000/ws`;
	const opts: Bun.WebSocketOptions = authHeader ? { headers: { Authorization: authHeader } } : {};
	const upstream = new WebSocket(url, opts as unknown as string[]);

	upstream.addEventListener("open", () => {
		console.log(`[proxy] connected to upstream ${project}`);
	});

	upstream.addEventListener("message", (event) => {
		try {
			if (typeof event.data === "string") {
				clientWs.send(event.data);
			} else if (event.data instanceof ArrayBuffer) {
				clientWs.send(new Uint8Array(event.data));
			} else {
				clientWs.send(event.data as string);
			}
		} catch {
			// Client already closed
		}
	});

	upstream.addEventListener("close", () => {
		console.log(`[proxy] upstream ${project} closed`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Already closed
		}
	});

	upstream.addEventListener("error", (event) => {
		const msg = event instanceof ErrorEvent ? event.message : String(event);
		console.log(`[proxy] upstream ${project} error: ${msg}`);
		upstreamMap.delete(clientWs);
		try {
			clientWs.close();
		} catch {
			// Already closed
		}
	});

	upstreamMap.set(clientWs, upstream);
}

export function handleProxyMessage(clientWs: ServerWebSocket<WsData>, data: string | Buffer): void {
	const upstream = upstreamMap.get(clientWs);
	if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
	if (typeof data === "string") {
		upstream.send(data);
	} else {
		upstream.send(data);
	}
}

export function handleProxyClose(clientWs: ServerWebSocket<WsData>): void {
	const upstream = upstreamMap.get(clientWs);
	upstreamMap.delete(clientWs);
	if (!upstream) return;
	console.log(`[proxy] client disconnected, closing upstream ${clientWs.data.proxyProject}`);
	try {
		if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
			upstream.close();
		}
	} catch {
		// Already closed
	}
}

export function isProxyConnection(ws: ServerWebSocket<WsData>): boolean {
	return upstreamMap.has(ws);
}
