import { describe, expect, it } from "vitest";
import { decrypt, encrypt, frame, unframe } from "../gateway/devices/kasa/codec.js";

const INFO_COMMAND = '{"system":{"get_sysinfo":{}}}';

describe("Kasa XOR codec", () => {
	it("round trips raw discovery payloads and framed TCP payloads", () => {
		const encrypted = encrypt(INFO_COMMAND);

		expect(decrypt(encrypted)).toBe(INFO_COMMAND);
		expect(unframe(frame(INFO_COMMAND))).toBe(INFO_COMMAND);
	});

	it("starts the autokey at 0xab", () => {
		expect(encrypt(INFO_COMMAND)[0]).toBe("{".charCodeAt(0) ^ 0xab);
	});
});
