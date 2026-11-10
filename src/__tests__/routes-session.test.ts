import { describe, expect, it, vi } from "vitest";
import { createSessionRoutes } from "../gateway/routes/routesSession.js";
import type { SessionRecord } from "../shared/session-store.js";

function request(body: unknown, token = "session-token"): Request {
	return new Request("http://gateway/session/type", {
		method: "POST",
		headers: { "x-session-token": token },
		body: JSON.stringify(body),
	});
}

function routes(record: SessionRecord | null) {
	const relayToHost = vi.fn(async () => ({ ok: true, result: { typed: true } }));
	const sessionRoutes = createSessionRoutes({
		auth: {
			resolveConfirmedManagedSession: (req: Request) =>
				req.headers.get("x-session-token") === "session-token" ? record : null,
		} as never,
		relayToHost,
	});
	return { relayToHost, ...sessionRoutes };
}

describe("POST /session/type", () => {
	it("requires the caller's session token", async () => {
		const route = routes({
			id: "copilot-one",
			spawn: "host",
			harness: "copilot",
			sessionLabel: "Copilot",
			lastSeen: 1,
		});

		const response = await route.typeSession(request({ text: "hello" }, "wrong-token"), { text: "hello" });
		expect(response.status).toBe(403);
		expect(route.relayToHost).not.toHaveBeenCalled();
	});

	it("refuses an authenticated Claude caller", async () => {
		const route = routes({
			id: "claude-one",
			spawn: "host",
			harness: "claude",
			sessionLabel: "Claude",
			lastSeen: 1,
		});

		const response = await route.typeSession(request({ text: "hello" }), { text: "hello" });
		expect(response.status).toBe(403);
		expect(route.relayToHost).not.toHaveBeenCalled();
	});

	it("rejects a body that tries to choose another target", async () => {
		const route = routes({
			id: "copilot-one",
			spawn: "host",
			harness: "copilot",
			sessionLabel: "Copilot",
			lastSeen: 1,
		});

		const body = { text: "hello", target: { kind: "host", name: "other", sessionName: "session" } };
		const response = await route.typeSession(request(body), body);
		expect(response.status).toBe(400);
		expect(route.relayToHost).not.toHaveBeenCalled();
	});

	it.each([
		["host", "host"],
		["fixture-app", "devcontainer"],
	] as const)("relays a Copilot caller on %s to the pane named by its record", async (spawn, kind) => {
		const route = routes({
			id: "copilot-one",
			spawn,
			harness: "copilot",
			sessionLabel: "Copilot",
			lastSeen: 1,
		});
		const body = { text: '<channel source="switchboard">hello</channel>' };

		const response = await route.typeSession(request(body), body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ typed: true });
		expect(route.relayToHost).toHaveBeenCalledWith({
			kind: "typeIntoPane",
			target: { kind, name: spawn, sessionName: "copilot-one" },
			text: body.text,
		});
	});
});
