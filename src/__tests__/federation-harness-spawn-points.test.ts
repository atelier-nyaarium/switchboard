import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySpawnPoints } from "../shared/types.js";
import type { FakeSpawnLists } from "../testing/fakeHost.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("the spawn points a Gateway reports to the phone", () => {
	let h: FederationHarness | undefined;
	afterEach(async () => {
		await h?.close();
		h = undefined;
	});

	/** This Gateway's row, once its daemon's catalog landed. */
	const reported = async (spawnLists: FakeSpawnLists): Promise<GatewaySpawnPoints> => {
		const harness = await startFederationHarness({ host: { hostSpawns: ["windows"], spawnLists } });
		h = harness;
		return harness.waitFor(async () => {
			const { planes } = await harness.phone.planesRead({});
			const payload = planes.find((plane) => plane.name === "presence")?.payload as
				| { spawnPoints?: GatewaySpawnPoints[] }
				| undefined;
			const row = payload?.spawnPoints?.find((point) => point.gatewayId === harness.set.gateway.id);
			return row?.hostSpawns.includes("windows") ? row : undefined;
		}, "the catalog in the presence plane");
	};

	it("names each CLI's spawn points as the daemon's `harnessSpawns` lists them", async () => {
		const row = await reported({ harnessSpawns: { claude: ["host", "windows"], copilot: ["windows"] } });

		expect(row).toMatchObject({
			harnessSpawns: { claude: ["host", "windows"], copilot: ["windows"] },
			claudeSpawns: ["host", "windows"],
			copilotSpawns: ["windows"],
		});
	}, 30_000);

	it("reads an older daemon's two lists when it sent no `harnessSpawns`", async () => {
		const row = await reported({ claudeSpawns: ["host"], copilotSpawns: ["host", "windows"] });

		expect(row.harnessSpawns).toEqual({ claude: ["host"], copilot: ["host", "windows"] });
	}, 30_000);

	it("falls back to the two lists when the `harnessSpawns` map is malformed", async () => {
		const row = await reported({
			harnessSpawns: { claude: "host" } as never,
			claudeSpawns: ["host"],
			copilotSpawns: ["host", "windows"],
		});

		expect(row.harnessSpawns).toEqual({ claude: ["host"], copilot: ["host", "windows"] });
	}, 30_000);

	it("offers and creates into a project named with an underscore, and never offers a name that is no address segment", async () => {
		const harness = await startFederationHarness({
			wakeTimeoutMs: 300,
			host: {
				projects: [
					{ team: "client_portal", projectPath: "/home/fixture/client_portal" },
					{ team: "Client Portal", projectPath: "/home/fixture/Client Portal" },
				],
			},
		});
		h = harness;
		const teams = await harness.waitFor(async () => {
			const { planes } = await harness.phone.planesRead({});
			const payload = planes.find((plane) => plane.name === "presence")?.payload as
				| { rows?: Array<{ team: string }> }
				| undefined;
			const names = payload?.rows?.map((row) => row.team) ?? [];
			return names.includes("client_portal") ? names : undefined;
		}, "the catalog's project in the presence plane");
		const { result } = await harness.phone.value({
			kind: "create_session",
			target: harness.target("client_portal"),
			sessionName: "probe",
		});

		expect(teams).not.toContain("Client Portal");
		expect(result).toMatchObject({ created: true });
		expect(harness.host.wakes.map((frame) => frame.team)).toContain("client_portal.probe");
	}, 30_000);

	it("reads the oldest daemon, which sent no list, as Claude everywhere and Copilot nowhere", async () => {
		const row = await reported({});

		expect(row.harnessSpawns).toEqual({ claude: ["host", "windows"], copilot: [] });
	}, 30_000);
});
