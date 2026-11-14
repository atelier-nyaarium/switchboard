import { describe, expect, it } from "vitest";
import type { HostStageDeps } from "../gateway/compose/composeHost.js";
import { composeHost } from "../gateway/compose/composeHost.js";
import { createDeviceScan } from "../gateway/devices/scan.js";
import { createWebSocketHandlers } from "../gateway/websocket.js";
import { createHostOpRunner, type TmuxOps } from "../mcp/devcontainer/hostOpRunner.js";
import { processAmbient } from "../shared/ambient.js";
import type { HostOp } from "../shared/host-op.js";
import { createFakeSocket } from "../testing/fakeSocket.js";

const candidate = {
	mac: "aa:bb:cc:dd:ee:ff",
	address: "192.168.1.80",
	alias: "Desk lamp",
	model: "HS103(US)",
	hardware: "3.0",
	firmware: "1.0.3",
};

describe("Gateway device scan", () => {
	it("answers daemon_away when no host is connected", async () => {
		const scan = createDeviceScan(async () => ({ ok: false, error: "host daemon offline" }));

		expect(await scan()).toEqual({ kind: "refused", code: "daemon_away" });
	});

	it("answers timeout when the host relay bound expires", async () => {
		const scan = createDeviceScan(async () => ({ ok: false, error: "host op timed out", errorKind: "timeout" }));

		expect(await scan()).toEqual({ kind: "refused", code: "timeout" });
	});

	it("answers scan_failed when the daemon returns a typed refusal", async () => {
		const scan = createDeviceScan(async () => ({ ok: true, result: { reason: "no_interface" } }));

		expect(await scan()).toEqual({ kind: "refused", code: "scan_failed" });
	});

	it("relays through the host frame and coordinator", async () => {
		const ambient = processAmbient();
		const fakeHost = createFakeSocket();
		fakeHost.ws.data.teamName = "host";
		const registry = new Map([["host", new Map([["daemon", fakeHost.ws]])]]);
		const knownTeamPaths = new Map<string, string>();
		const offlineCatalog = new Map<string, string>();
		const sessions = {
			registry,
			sessionStore: {} as HostStageDeps["sessions"]["sessionStore"],
			presence: {} as HostStageDeps["sessions"]["presence"],
			isAvailableProject: () => false,
			hostSpawnPoints: { known: false, ids: [] },
			knownTeamPaths,
			offlineCatalog,
		} as HostStageDeps["sessions"];
		const host = composeHost({ sessions, wakeTimeoutMs: 1_000, ambient });
		const websocket = createWebSocketHandlers({
			ambient,
			registry,
			conversationRegistry: new Map(),
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator: host.wakeCoordinator,
			hostOpCoordinator: host.hostOpCoordinator,
			config: { HEARTBEAT_INTERVAL_MS: 30_000, MISSED_PINGS_LIMIT: 2 },
		});
		const ops: TmuxOps = {
			peekPane: async () => ({ kind: "tmux", ansi: "", hash: "" }),
			sendText: async () => {},
			sendKey: async () => {},
			answerPrompt: async () => "stale" as const,
			createSession: async () => {},
			reloadPlugins: async () => {},
			killSession: async () => {},
			listDirs: async () => ({ entries: [] }),
			readSkill: async () => ({ kind: "refused", code: "missing" }),
			kasaScan: async () => ({ candidates: [candidate] }),
			wifiNetwork: async () => ({ ssid: "Home" }),
			typeIntoPane: async () => ({ typed: true }),
			containerStart: async () => {},
			containerStop: async () => {},
		};
		const runner = createHostOpRunner(ops);
		const receivedOps: unknown[] = [];
		fakeHost.onFrame((frame) => {
			if (frame.type !== "host_op") return;
			receivedOps.push(frame.op);
			void runner.run(frame.op as HostOp).then((result) => {
				websocket.message(
					fakeHost.ws,
					JSON.stringify({ type: "host_op_reply", reqId: frame.reqId, ok: true, result }),
				);
			});
		});

		try {
			expect(await createDeviceScan(host.relayToHost)()).toMatchObject({ kind: "ok", candidates: [candidate] });
			expect(receivedOps).toContainEqual({ kind: "kasaScan" });
			expect(receivedOps).toContainEqual({ kind: "bleScan" });
		} finally {
			ambient.clearInterval(host.presenceWatchTimer);
			ambient.clearInterval(host.deviceWatchTimer);
			ambient.clearInterval(websocket.heartbeatInterval);
		}
	});

	it("adds catalogued Bluetooth devices beside Kasa candidates, leaving strangers out", async () => {
		const device = {
			mac: "ce:1c:44:06:3c:5d",
			name: "GVH5110_3C5D",
			signal: -61,
			data: { "1": "010103bac864" },
			services: ["ec88"],
		};
		const stranger = { mac: "aa:bb:cc:00:11:22", signal: -40, data: { "76": "0215" }, services: [] };
		const scan = createDeviceScan(async (op) =>
			op.kind === "kasaScan"
				? { ok: true, result: { candidates: [candidate] } }
				: { ok: true, result: { devices: [stranger, device] } },
		);

		expect(await scan()).toEqual({
			kind: "ok",
			candidates: [candidate],
			nearby: [{ ...device, radio: "gateway" }],
			bluetooth: true,
		});
	});

	it("keeps Bluetooth devices when the Kasa scan fails", async () => {
		const device = { mac: "ce:1c:44:06:3c:5d", signal: -61, data: { "1": "010103bac864" }, services: ["ec88"] };
		const scan = createDeviceScan(async (op) =>
			op.kind === "kasaScan"
				? { ok: true, result: { reason: "no_interface" } }
				: { ok: true, result: { devices: [device] } },
		);

		expect(await scan()).toMatchObject({ kind: "ok", candidates: [], nearby: [{ mac: device.mac }] });
	});

	it("keeps Kasa candidates when the host has no Bluetooth radio, and remembers it has none", async () => {
		const scan = createDeviceScan(async (op) =>
			op.kind === "kasaScan"
				? { ok: true, result: { candidates: [candidate] } }
				: { ok: true, result: { reason: "no_radio" } },
		);

		expect(scan.bluetooth()).toBeUndefined();
		expect(await scan()).toEqual({ kind: "ok", candidates: [candidate], bluetooth: false });
		expect(scan.bluetooth()).toBe(false);
	});

	it("does not turn a malformed relay answer into an empty success", async () => {
		const scan = createDeviceScan(async () => ({
			ok: true,
			result: { candidates: [{ ...candidate, mac: "bad" }] },
		}));

		expect(await scan()).toEqual({ kind: "refused", code: "scan_failed" });
	});
});
