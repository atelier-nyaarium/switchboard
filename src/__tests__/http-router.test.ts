import { describe, expect, it, vi } from "vitest";
import { createHttpRouter, NOT_ENROLLED } from "../gateway/httpRouter.js";
import { unenrolledHealth } from "../gateway/routes/routesStatus.js";

function unenrolledRouter(overrides: Partial<Parameters<typeof createHttpRouter>[0]> = {}) {
	return createHttpRouter({
		enrollArm: async () => ({ ok: false, error: "closing" }),
		enrollStatus: () => ({ state: "none" }),
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
		const router = unenrolledRouter();

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
			["POST", "/session/type"],
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

	it("routes typed session delivery through the active routes", async () => {
		const typeSession = vi.fn(async () => Response.json({ typed: true }));
		const router = unenrolledRouter({ routes: () => ({ typeSession }) as never });
		const body = { text: '<channel source="switchboard">hello</channel>' };

		const response = await router(
			new Request("http://gateway/session/type", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		);
		expect(await response.json()).toEqual({ typed: true });
		expect(typeSession).toHaveBeenCalledWith(expect.any(Request), body);
	});

	it("arms and reads a setup only for the host token", async () => {
		const enrollArm = vi.fn(async (routerUrl: string) => ({
			ok: false as const,
			error: "router_unreachable" as const,
			router: routerUrl,
		}));
		const router = unenrolledRouter({
			hostWsToken: "secret",
			enrollArm,
			enrollStatus: () => ({ state: "waiting" }),
		});
		const arm = (authorization: string | undefined, body: unknown) =>
			router(
				new Request("http://gateway/enroll/arm", {
					method: "POST",
					body: JSON.stringify(body),
					headers: authorization ? { authorization } : {},
				}),
			);
		const status = (authorization?: string) =>
			router(new Request("http://gateway/enroll/status", { headers: authorization ? { authorization } : {} }));

		for (const authorization of [undefined, "Bearer wrong"]) {
			expect((await arm(authorization, { host: "router.lan" })).status).toBe(403);
			expect((await status(authorization)).status).toBe(403);
		}
		for (const address of [{ port: 443 }, { host: "router.lan/elsewhere" }, { host: "user@router.lan" }]) {
			expect((await arm("Bearer secret", address)).status).toBe(400);
		}
		expect(enrollArm).not.toHaveBeenCalled();

		await arm("Bearer secret", { host: "router.lan" });
		expect(enrollArm).toHaveBeenLastCalledWith("https://router.lan:20001");
		const answer = await arm("Bearer secret", { host: "10.0.0.5", port: 443 });
		expect(await answer.json()).toEqual({ ok: false, error: "router_unreachable", router: "https://10.0.0.5:443" });
		expect(await (await status("Bearer secret")).json()).toEqual({ state: "waiting" });
	});

	it("requires the host token to retire", async () => {
		const noToken = unenrolledRouter();
		expect(
			(await noToken(new Request("http://gateway/federation/retire", { method: "POST", body: "{}" }))).status,
		).toBe(403);

		const retire = async () => ({ outcome: "retired" });
		const router = unenrolledRouter({ hostWsToken: "secret", retire });
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
