// What a hook asks the Gateway, as its own session.

import { isInsideContainer } from "../shared/env.js";

export type HookEnv = Readonly<Record<string, string | undefined>>;

/** The answer's JSON, or null without a token, an answer or on failure. Never throws. */
export async function askGateway(
	env: HookEnv,
	route: string,
	timeoutMs: number,
	fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
	const token = env.SWITCHBOARD_SESSION_TOKEN;
	if (!token) return null;
	const base = env.BRIDGE_ROUTER_URL ?? (isInsideContainer() ? "http://switchboard:20000" : "http://localhost:20000");
	try {
		const res = await fetchImpl(`${base}${route}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-session-token": token },
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}
