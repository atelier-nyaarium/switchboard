import { describe, expect, it } from "vitest";
import { jsonResponse } from "../gateway/routeSchemas.js";
import { createPresenceRoutes } from "../gateway/routes/routesPresence.js";
import type { TeamInfo } from "../shared/types.js";

const row = (team: string, gatewayId: string, role?: "assistant"): TeamInfo => ({
	team,
	gatewayId,
	domainId: "home",
	status: "online",
	kind: "loose",
	queue_depth: 0,
	...(role ? { role } : {}),
});

describe("discovery for a session", () => {
	it("lists every Gateway's sessions but no assistant", async () => {
		const projection = {
			plane: { epoch: 1, version: 1 },
			owner: { domainId: "home", displayName: null, isAdminDomain: true },
			rows: [row("host.assistant", "far", "assistant"), row("app.far", "far")],
			linked: [],
			roster: [],
			coverage: { rosterKnown: true, asked: 2, answered: 2 },
			spawnPoints: [],
		};
		const { discover } = createPresenceRoutes({
			config: { localGatewayId: "near", localDomainId: "home" },
			localDomain: "home",
			routerClient: {
				isRegistered: () => true,
				callInboxTool: async () => ({ callId: "c1", result: projection }),
			},
			teams: () => jsonResponse([row("app.near", "near")]),
		});

		const listed = (await (await discover()).json()) as TeamInfo[];

		expect(listed.map((found) => `${found.gatewayId}/${found.team}`)).toEqual(["near/app.near", "far/app.far"]);
	});
});
