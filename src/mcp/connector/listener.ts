import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "bun";
import { isInsideContainer } from "../../shared/env.js";
import { getLoadedToolNames, getToolSchema } from "./projectTools.js";
import { addClient, type ClientData, getAllClients, getClient, removeClient } from "./sessions.js";

const TAG = "[connector]";

////////////////////////////////
//  Interfaces & Types

export interface ListenerState {
	mode: "http" | "https";
	hostname: string;
	port: number;
	server: Server<ClientData>;
}

interface PendingInvocation {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	clientHash: string;
}

////////////////////////////////
//  State

let state: ListenerState | null = null;
let authToken: string | null = null;
const pendingInvocations = new Map<string, PendingInvocation>();
let requestCounter = 0;

////////////////////////////////
//  Functions & Helpers

export function setAuthToken(token: string | null): void {
	authToken = token;
}

export function getAuthToken(): string | null {
	return authToken;
}

export function getListenerState(): ListenerState | null {
	return state;
}

export function startListener(port: number): void {
	const hostname = isInsideContainer() ? "0.0.0.0" : "127.0.0.1";
	state = createServer({ hostname, port, mode: "http" });
	console.error(`${TAG} Listener started on ${hostname}:${port} (HTTP)`);
}

export function restartWithTls(connectorDir: string, port: number): void {
	const certPath = `${connectorDir}/server.crt`;
	const keyPath = `${connectorDir}/server.key`;

	if (!existsSync(certPath) || !existsSync(keyPath)) {
		throw new Error(`TLS certs not found in ${connectorDir}. Run mcpConnectorGenerateCert first.`);
	}

	const cert = readFileSync(certPath, "utf-8");
	const key = readFileSync(keyPath, "utf-8");

	stopListener();
	state = createServer({ hostname: "0.0.0.0", port, mode: "https", cert, key });
	console.error(`${TAG} Listener restarted on 0.0.0.0:${port} (HTTPS)`);
}

export function restartWithoutTls(port: number): void {
	stopListener();
	const hostname = isInsideContainer() ? "0.0.0.0" : "127.0.0.1";
	state = createServer({ hostname, port, mode: "http" });
	console.error(`${TAG} Listener restarted on ${hostname}:${port} (HTTP)`);
}

export function stopListener(): void {
	if (state) {
		state.server.stop(true);
		state = null;
	}
	for (const [id, pending] of pendingInvocations) {
		clearTimeout(pending.timer);
		pending.reject(new Error(`Listener stopped`));
		pendingInvocations.delete(id);
	}
}

export function invokeOnClient(shortHash: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
	const client = getClient(shortHash);
	if (!client) {
		return Promise.reject(
			new Error(`Client ${shortHash} not connected. Call mcpConnectorStatus for active clients.`),
		);
	}

	// Validate params against loaded Zod schema
	const toolSchema = getToolSchema(tool);
	if (toolSchema) {
		const parsed = toolSchema.safeParse(args);
		if (!parsed.success) {
			return Promise.reject(new Error(`Invalid params for tool "${tool}": ${parsed.error.message}`));
		}
	}

	const id = `req-${++requestCounter}`;

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingInvocations.delete(id);
			reject(new Error(`Tool invocation timed out after 30s (${tool} on client ${shortHash})`));
		}, 30_000);

		pendingInvocations.set(id, { resolve, reject, timer, clientHash: shortHash });

		client.ws.send(JSON.stringify({ type: "invoke", id, tool, args }));
	});
}

////////////////////////////////
//  Internal

interface CreateServerParams {
	hostname: string;
	port: number;
	mode: "http" | "https";
	cert?: string;
	key?: string;
}

function createServer({ hostname, port, mode, cert, key }: CreateServerParams): ListenerState {
	const tls = mode === "https" && cert && key ? { cert, key } : undefined;

	const server = Bun.serve<ClientData>({
		hostname,
		port,
		tls,
		fetch(req, server) {
			const url = new URL(req.url);

			// In HTTPS mode, enforce bearer token auth on all endpoints
			if (mode === "https" && authToken) {
				const authHeader = req.headers.get("Authorization") ?? "";
				const expected = `Bearer ${authToken}`;
				const a = Buffer.from(authHeader);
				const b = Buffer.from(expected);
				if (a.length !== b.length || !timingSafeEqual(a, b)) {
					return new Response(`Unauthorized`, { status: 401 });
				}
			}

			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, {
					data: { shortHash: "" },
				});
				// Bun expects undefined after successful WS upgrade; types require the cast
				if (upgraded) return undefined as unknown as Response;
				return new Response(`WebSocket upgrade failed`, { status: 400 });
			}

			if (url.pathname === "/status") {
				const clients = getAllClients().map((c) => ({
					clientId: c.shortHash,
					connectedAt: c.connectedAt.toISOString(),
					remoteAddress: c.remoteAddress,
				}));
				return Response.json({ mode, hostname, port, clients });
			}

			return new Response(`Not Found`, { status: 404 });
		},
		websocket: {
			open(ws) {
				const address = ws.remoteAddress || "unknown";
				const session = addClient(ws, address);
				console.error(`${TAG} Client connected: ${session.shortHash} (${address})`);
			},
			message(ws, message) {
				try {
					const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

					if (data.type === "register" && Array.isArray(data.tools)) {
						const clientTools: string[] = data.tools;
						const knownTools = getLoadedToolNames();
						const unknown = clientTools.filter((t: string) => !knownTools.includes(t));
						const valid = clientTools.filter((t: string) => knownTools.includes(t));

						if (unknown.length > 0) {
							console.error(
								`${TAG} Client ${ws.data.shortHash} registered unknown tools: ${unknown.join(", ")}`,
							);
						}
						console.error(
							`${TAG} Client ${ws.data.shortHash} registered ${valid.length}/${clientTools.length} tool(s)`,
						);

						const session = getClient(ws.data.shortHash);
						if (session) session.registeredTools = clientTools;
					} else if (data.type === "result" && data.id) {
						const pending = pendingInvocations.get(data.id);
						if (pending) {
							clearTimeout(pending.timer);
							pendingInvocations.delete(data.id);
							pending.resolve(data.data);
						}
					}
				} catch {
					console.error(`${TAG} Invalid message from ${ws.data.shortHash}`);
				}
			},
			close(ws) {
				const hash = ws.data.shortHash;
				console.error(`${TAG} Client disconnected: ${hash}`);
				removeClient(hash);

				for (const [id, pending] of pendingInvocations) {
					if (pending.clientHash === hash) {
						clearTimeout(pending.timer);
						pending.reject(new Error(`Client ${hash} disconnected during invocation`));
						pendingInvocations.delete(id);
					}
				}
			},
		},
	});

	return { mode, hostname, port, server };
}
