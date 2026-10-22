import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { startRouterClient } from "../gateway/router/routerClient.js";
import { processAmbient } from "../shared/ambient.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

class StubRouterSocket extends EventEmitter {
	readyState = 0;
	sent: string[] = [];

	send(frame: string): void {
		this.sent.push(frame);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close");
	}

	terminate(): void {
		this.close();
	}

	ping(): void {}

	receive(frame: unknown): void {
		this.emit("message", Buffer.from(JSON.stringify(frame)));
	}
}

describe("router client shutdown", () => {
	it("drops new router frames and settles calls already in flight", async () => {
		let closing = false;
		let dispatched = 0;
		const socket = new StubRouterSocket();
		const client = startRouterClient({
			ambient: processAmbient(),
			url: "ws://router.test",
			headers: {},
			gatewayId: "gateway",
			domainId: "domain",
			createSocket: () => socket as unknown as WebSocket,
			isClosing: () => closing,
			onGatewayRelay: () => {
				dispatched += 1;
			},
		});

		socket.readyState = 1;
		socket.emit("open");
		const pending = client.callTool("pending", {});
		const call = JSON.parse(socket.sent.at(-1) ?? "{}") as { callId: string };
		closing = true;
		socket.emit("message", Buffer.from(JSON.stringify({ type: "gateway_relay" })));
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ type: "tool_result", callId: call.callId, result: { settled: true } })),
		);

		expect(dispatched).toBe(0);
		expect(await pending).toMatchObject({ result: { settled: true } });
		client.stop();
	});

	it("does not reconnect after a socket drops while closing", async () => {
		let closing = false;
		let sockets = 0;
		const ambient = fakeAmbient({ drive: "manual" });
		const socket = new StubRouterSocket();
		const client = startRouterClient({
			ambient,
			url: "ws://router.test",
			headers: {},
			gatewayId: "gateway",
			domainId: "domain",
			createSocket: () => {
				sockets += 1;
				return socket as unknown as WebSocket;
			},
			isClosing: () => closing,
		});

		try {
			socket.readyState = 1;
			socket.emit("open");
			const registration = JSON.parse(socket.sent[0] ?? "{}") as { callId: string };
			socket.receive({ type: "tool_result", callId: registration.callId, result: { ok: true, incarnation: 1 } });
			await Promise.resolve();

			closing = true;
			socket.close();
			await ambient.advance(10_000);

			expect(sockets).toBe(1);
		} finally {
			client.stop();
		}
	});

	it("settles registration without side effects while closing", async () => {
		let closing = false;
		let registered = 0;
		let domains = 0;
		let reaches = 0;
		const ambient = fakeAmbient({ drive: "manual" });
		const socket = new StubRouterSocket();
		const client = startRouterClient({
			ambient,
			url: "ws://router.test",
			headers: {},
			gatewayId: "gateway",
			domainId: "domain",
			createSocket: () => socket as unknown as WebSocket,
			isClosing: () => closing,
			onRegistered: () => {
				registered += 1;
			},
			onDomainSync: () => {
				domains += 1;
			},
			onReach: () => {
				reaches += 1;
			},
		});

		try {
			socket.readyState = 1;
			socket.emit("open");
			const registration = JSON.parse(socket.sent[0] ?? "{}") as { callId: string };
			closing = true;
			socket.receive({
				type: "tool_result",
				callId: registration.callId,
				result: {
					ok: true,
					incarnation: 1,
					domain: { domainId: "domain" },
					reach: { publicHost: "router.test" },
				},
			});
			await Promise.resolve();

			expect([registered, domains, reaches]).toEqual([0, 0, 0]);
			expect(ambient.scheduled()).toBe(1);
		} finally {
			client.stop();
		}
	});

	it("settles a tool error while closing", async () => {
		let closing = false;
		const ambient = fakeAmbient({ drive: "manual" });
		const socket = new StubRouterSocket();
		const client = startRouterClient({
			ambient,
			url: "ws://router.test",
			headers: {},
			gatewayId: "gateway",
			domainId: "domain",
			createSocket: () => socket as unknown as WebSocket,
			isClosing: () => closing,
		});

		try {
			socket.readyState = 1;
			socket.emit("open");
			const registration = JSON.parse(socket.sent[0] ?? "{}") as { callId: string };
			socket.receive({ type: "tool_result", callId: registration.callId, result: { ok: true, incarnation: 1 } });
			await Promise.resolve();

			const pending = client.callTool("pending", {});
			const call = JSON.parse(socket.sent.at(-1) ?? "{}") as { callId: string };
			closing = true;
			socket.receive({ type: "tool_error", callId: call.callId, error: "failed" });

			expect(ambient.scheduled()).toBe(1);
			expect(await pending).toMatchObject({ callId: call.callId, error: expect.any(String) });
		} finally {
			client.stop();
		}
	});
});
