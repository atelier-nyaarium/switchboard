import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { composeGateway, type GatewayGraph } from "../gateway/composeGateway.js";
import { DurableStore } from "../shared/durable-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeSocket } from "../testing/fakeSocket.js";
import { FixtureWorld } from "../testing/fixtureWorld.js";
import { loadIdentitySet } from "../testing/identitySet.js";

const routerState = vi.hoisted(() => ({ stopped: false }));

vi.mock("../gateway/router/routerClient.js", () => ({
	startRouterClient: () => ({
		callTool: async () => ({ callId: "", result: {} }),
		callInboxTool: async () => ({ callId: "", result: {} }),
		incarnation: () => 1,
		isConnected: () => !routerState.stopped,
		isRegistered: () => !routerState.stopped,
		acceptedOpLedgerProtocol: () => 1,
		stop: () => {
			routerState.stopped = true;
		},
	}),
}));

function gatewayFixture(): { root: string; ambient: ReturnType<typeof fakeAmbient>; gateway: GatewayGraph } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-close-"));
	const dataDir = path.join(root, "gateway");
	const federationDir = path.join(dataDir, "federation");
	const set = loadIdentitySet();
	const ambient = fakeAmbient({ drive: "manual" });
	routerState.stopped = false;
	FixtureWorld.from(set).gatewayBootstrap(
		federationDir,
		{ routerUrl: "https://router.test", routerCertFp: "AA" },
		undefined,
		ambient,
	);
	const gateway = composeGateway({
		config: {
			dataDir,
			federationDir,
			logDir: path.join(root, "log"),
			gatewayId: set.gateway.id,
			maxBlobStoreBytes: 1_000_000,
			wakeTimeoutMs: 10_000,
			enrollTlsPort: 0,
			enrollLanHost: "127.0.0.1",
			hostWsToken: set.tokens.host,
			routerBootstrapUrl: null,
		},
		ambient,
		allowFixtureIdentity: true,
	});
	return { root, ambient, gateway };
}

describe("gateway close fence", () => {
	it("fences activation and rejects a body completed during close", async () => {
		const fixture = gatewayFixture();
		let releaseBody = () => {};
		let markBodyStarted = () => {};
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve;
		});
		const bodyGate = new Promise<void>((resolve) => {
			releaseBody = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				markBodyStarted();
				await bodyGate;
				controller.enqueue(new TextEncoder().encode("{"));
				controller.close();
			},
		});

		try {
			const post = fixture.gateway.router(
				new Request("http://gateway.test/health", {
					method: "POST",
					body,
					duplex: "half",
				} as RequestInit & { duplex: "half" }),
			);
			await bodyStarted;
			const closing = fixture.gateway.close();
			expect(fixture.gateway.close()).toBe(closing);
			fixture.gateway.faults.activateAgain();
			const response = await fixture.gateway.router(new Request("http://gateway.test/health"));
			const socket = createFakeSocket();
			fixture.gateway.wsHandlers.open(socket.ws);
			releaseBody();
			const postResponse = await post;
			await closing;

			expect(response.status).toBe(503);
			expect(postResponse.status).toBe(503);
			expect(socket.ws.readyState).toBe(WebSocket.CLOSED);
		} finally {
			await fixture.gateway.close().catch(() => undefined);
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("stops timers and the Router client when a flush fails", async () => {
		const fixture = gatewayFixture();
		const firstError = new Error();
		const laterError = new Error();
		const saveChecked = vi
			.spyOn(DurableStore.prototype, "saveChecked")
			.mockImplementationOnce(() => {
				throw firstError;
			})
			.mockImplementationOnce(() => {
				throw laterError;
			});

		try {
			expect(fixture.gateway.faults.routerRegistered()).toBe(true);
			expect(fixture.ambient.scheduled()).toBeGreaterThan(0);
			await expect(fixture.gateway.close()).rejects.toBe(firstError);
			expect(fixture.gateway.faults.routerRegistered()).toBe(false);
			expect(fixture.ambient.scheduled()).toBe(0);
		} finally {
			saveChecked.mockRestore();
			await fixture.gateway.close().catch(() => undefined);
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
