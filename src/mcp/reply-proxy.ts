import type { ResponsePayload } from "../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface ReplyProxy {
	port: number;
	close: () => void;
}

type RouterPostFn = (path: string, body: unknown) => Promise<unknown>;

////////////////////////////////
//  Functions & Helpers

export function createReplyProxy(sessionId: string, routerPost: RouterPostFn): Promise<ReplyProxy> {
	return new Promise((resolve) => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				if (req.method !== "POST") {
					return new Response(null, { status: 405 });
				}
				try {
					const data = (await req.json()) as ResponsePayload;
					if (data.session_id !== sessionId) {
						return new Response(JSON.stringify({ error: `session_id mismatch` }), {
							status: 400,
							headers: { "Content-Type": "application/json" },
						});
					}
					await routerPost("/respond", data);
					console.error(`[bridge] reply proxy received reply: ${data.status} [${sessionId.slice(0, 8)}...]`);
					server.stop();
					return new Response(JSON.stringify({ delivered: true }), {
						headers: { "Content-Type": "application/json" },
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return new Response(JSON.stringify({ error: message }), {
						status: 500,
						headers: { "Content-Type": "application/json" },
					});
				}
			},
		});

		resolve({
			port: server.port!,
			close: () => server.stop(),
		});
	});
}
