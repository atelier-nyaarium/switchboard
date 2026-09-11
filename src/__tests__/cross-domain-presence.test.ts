import { describe, expect, it } from "vitest";
import { toCrossDomainPresenceSession } from "../shared/presence-projection.js";
import { Address } from "../shared/session-id.js";
import type { TeamInfo } from "../shared/types.js";

const session = (team: string, over: Partial<TeamInfo> = {}): TeamInfo => ({
	team,
	gatewayId: "gateway",
	domainId: "local",
	status: "online",
	kind: "devcontainer",
	queue_depth: 2,
	...over,
});

const address = (team: string) => Address.of("local", "gateway", ...(team.split(".") as [string, string]));

describe("cross-domain presence projection", () => {
	it("projects allowed kinds and truncates fields", () => {
		const result = toCrossDomainPresenceSession(
			session("app.chat", {
				sessionLabel: "x".repeat(100),
				description: "y".repeat(150),
			}),
			address,
		);
		expect(result).toEqual({
			team: "app.chat",
			gatewayId: "gateway",
			status: "online",
			kind: "devcontainer",
			sessionLabel: "x".repeat(64),
			description: "y".repeat(120),
			queueDepth: 2,
		});
		expect(toCrossDomainPresenceSession(session("one.chat", { kind: "loose" }), address)?.kind).toBe("loose");
		expect(toCrossDomainPresenceSession(session("app.chat", { kind: "console" as never }), address)).toBeNull();
		expect(toCrossDomainPresenceSession(session("missing"), () => null)).toBeNull();
	});
});
