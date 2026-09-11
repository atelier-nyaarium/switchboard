import { describe, expect, it } from "vitest";
import { createHttpRouter, NOT_ENROLLED } from "../gateway/httpRouter.js";
import { unenrolledHealth } from "../gateway/routes/routesStatus.js";

function unenrolledRouter(enrolled: (body: Record<string, unknown>) => Response) {
	return createHttpRouter({
		handleEnrollPost: enrolled,
		admitPayload: () => undefined,
		blobStore: {} as never,
		sessionAuthority: { mayUseLocalPlane: () => true },
		loopbackRoutes: new Map([["/vault/entries", async () => Response.json({ entries: [] })]]),
		routes: () => null,
		unenrolledHealth: () => unenrolledHealth("gw"),
	});
}

describe("createHttpRouter before a Domain", () => {
	it("answers health, and refuses every route that would mint an address", async () => {
		const router = unenrolledRouter(() => Response.json({ ok: true }));

		const health = await router(new Request("http://gateway/health"));
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			ok: true,
			gatewayId: "gw",
			domainId: null,
			router_registered: false,
		});

		for (const [method, path] of [
			["POST", "/send"],
			["GET", "/teams"],
			["POST", "/vault/entries"],
			["POST", "/blob/stat"],
		] as const) {
			const answer = await router(
				new Request(`http://gateway${path}`, { method, body: method === "POST" ? "{}" : null }),
			);
			expect(answer.status).toBe(503);
			expect(await answer.json()).toEqual({ error: NOT_ENROLLED });
		}
	});

	it("still takes the enrollment post", async () => {
		const router = unenrolledRouter((body) => Response.json({ got: body }));
		const answer = await router(new Request("http://gateway/enroll", { method: "POST", body: '{"a":1}' }));
		expect(await answer.json()).toEqual({ got: { a: 1 } });
	});
});
