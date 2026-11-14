import { describe, expect, it } from "vitest";
import { type DbusValue, decodeMessage, encodeMessage, messageLength } from "../mcp/devcontainer/bluetooth/dbusWire.js";

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("D-Bus wire", () => {
	it("matches a hand-checked empty method call vector", () => {
		const message = encodeMessage({
			type: "method_call",
			serial: 1,
			path: "/",
			interface: "org.test",
			member: "Ping",
		});

		expect(hex(message)).toBe(
			"6c01000100000000010000003500000001016f00010000002f0000000000000002017300080000006f72672e746573740000000000000000030173000400000050696e6700000000",
		);
		expect(decodeMessage(message)).toMatchObject({ type: "method_call", serial: 1, path: "/", member: "Ping" });
	});

	it("round trips aligned values, variants, dictionaries, and structs", () => {
		const message = {
			type: "method_call" as const,
			serial: 42,
			path: "/org/bluez/hci0",
			interface: "org.bluez.Adapter1",
			member: "SetDiscoveryFilter",
			destination: "org.bluez",
			bodySignature: "ybnqiuxtdsoga(yv)a{sv}(ns)",
			body: [
				255,
				true,
				-2,
				65530,
				-100,
				4_000_000_000,
				-9_223_372_036_854_775_000n,
				18_446_744_073_709_551_000n,
				-55.5,
				"name",
				"/org/bluez",
				"a{sv}",
				[[7, { signature: "s", value: "value" }]],
				new Map([
					["Transport", { signature: "s", value: "le" }],
					["DuplicateData", { signature: "b", value: true }],
				]),
				[-4, "field"],
			],
		};
		const decoded = decodeMessage(encodeMessage(message));

		expect(decoded).toMatchObject({
			type: "method_call",
			serial: 42,
			bodySignature: message.bodySignature,
			body: message.body,
		});
	});

	it("aligns file descriptors and separates nesting limits", () => {
		const message = encodeMessage({
			type: "method_call",
			serial: 9,
			path: "/",
			interface: "org.test",
			member: "Descriptors",
			bodySignature: "yh",
			body: [7, 0x01020304],
		});
		expect(decodeMessage(message).body).toEqual([7, 0x01020304]);

		const signature = `${"a".repeat(32)}${"(".repeat(32)}y${")".repeat(32)}`;
		let value: DbusValue = 7;
		for (let index = 0; index < 32; index++) value = [value];
		for (let index = 0; index < 32; index++) value = [value];
		expect(
			decodeMessage(encodeMessage({ type: "method_call", serial: 10, bodySignature: signature, body: [value] }))
				.body,
		).toEqual([value]);
		expect(() =>
			encodeMessage({ type: "method_call", serial: 11, bodySignature: `${"a".repeat(33)}y`, body: [[]] }),
		).toThrow();
	});

	it("round trips returns, errors, and signals", () => {
		const methodReturn = encodeMessage({
			type: "method_return",
			serial: 2,
			replySerial: 1,
			bodySignature: "s",
			body: [":1.4"],
		});
		const error = encodeMessage({
			type: "error",
			serial: 3,
			replySerial: 2,
			errorName: "org.example.Error",
			bodySignature: "s",
			body: ["failed"],
		});
		const signal = encodeMessage({
			type: "signal",
			serial: 4,
			path: "/",
			interface: "org.example.Events",
			member: "Changed",
			bodySignature: "as",
			body: [["one", "two"]],
		});

		expect(decodeMessage(methodReturn)).toMatchObject({ type: "method_return", replySerial: 1, body: [":1.4"] });
		expect(decodeMessage(error)).toMatchObject({ type: "error", errorName: "org.example.Error", body: ["failed"] });
		expect(decodeMessage(signal)).toMatchObject({ type: "signal", member: "Changed", body: [["one", "two"]] });
		expect(messageLength(methodReturn.subarray(0, 10))).toBeNull();
		expect(messageLength(methodReturn)).toBe(methodReturn.length);
	});

	it("reads big-endian frame lengths", () => {
		const prefix = Uint8Array.of(0x42, 2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0);
		expect(messageLength(prefix)).toBeNull();
		expect(messageLength(Uint8Array.from([...prefix, 0]))).toBe(17);
		const empty = Uint8Array.of(0x42, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0);
		expect(decodeMessage(empty)).toMatchObject({ type: "method_return", serial: 1 });
	});
});
