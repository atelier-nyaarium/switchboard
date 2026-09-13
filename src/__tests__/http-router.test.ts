import { describe, expect, it } from "vitest";
import { createHttpRouter, NOT_ENROLLED } from "../gateway/httpRouter.js";
import { unenrolledHealth } from "../gateway/routes/routesStatus.js";

function unenrolledRouter(
	enrolled: (body: Record<string, unknown>) => Response,
	overrides: Partial<Parameters<typeof createHttpRouter>[0]> = {},
) {
	return createHttpRouter({
		handleEnrollPost: enrolled,
		admitPayload: () => undefined,
		blobStore: {} as never,
		sessionAuthority: { mayUseLocalPlane: () => true },
		loopbackRoutes: new Map([["/vault/entries", async () => Response.json({ entries: [] })]]),
		routes: () => null,
		unenrolledHealth: () => unenrolledHealth("gw"),
		...overrides,
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

	it("requires the host token to retire", async () => {
		const noToken = unenrolledRouter(() => Response.json({ ok: true }));
		expect(
			(await noToken(new Request("http://gateway/federation/retire", { method: "POST", body: "{}" }))).status,
		).toBe(403);

		const retire = async () => ({ outcome: "retired" });
		const router = unenrolledRouter(() => Response.json({ ok: true }), { hostWsToken: "secret", retire });
		for (const authorization of [undefined, "Bearer wrong"]) {
			const answer = await router(
				new Request("http://gateway/federation/retire", {
					method: "POST",
					body: "{}",
					headers: authorization ? { authorization } : {},
				}),
			);
			expect(answer.status).toBe(403);
		}
		const answer = await router(
			new Request("http://gateway/federation/retire", {
				method: "POST",
				body: "{}",
				headers: { authorization: "Bearer secret" },
			}),
		);
		expect(await answer.json()).toEqual({ outcome: "retired" });
	});
});
