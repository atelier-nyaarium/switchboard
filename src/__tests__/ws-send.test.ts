import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import { reached, sendOn } from "../gateway/wsSend.js";
import type { WsData } from "../gateway/wsTypes.js";

function socket(answer: number | undefined | (() => never)): ServerWebSocket<WsData> {
	return { send: typeof answer === "function" ? answer : () => answer } as unknown as ServerWebSocket<WsData>;
}

describe("sendOn", () => {
	it("reads Bun's answer rather than the socket looking open", () => {
		expect(sendOn(socket(12), "frame", "probe")).toBe("sent");
		expect(sendOn(socket(-1), "frame", "probe")).toBe("queued");
		expect(sendOn(socket(0), "frame", "probe")).toBe("dropped");
	});

	it("does not call a loss on a socket that reports nothing", () => {
		expect(sendOn(socket(undefined), "frame", "probe")).toBe("sent");
	});

	it("treats a throwing socket as a drop instead of propagating", () => {
		const thrown = socket(() => {
			throw new Error("closed");
		});
		expect(sendOn(thrown, "frame", "probe")).toBe("dropped");
	});

	it("says so when a frame is lost, even if the caller ignores the answer", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			sendOn(socket(0), "frame", "a dropped probe");
			sendOn(socket(-1), "frame", "a queued probe");
			sendOn(socket(9), "frame", "a sent probe");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("a dropped probe");
		} finally {
			warn.mockRestore();
		}
	});

	it("counts a queued frame as reaching the peer and a dropped one as not", () => {
		expect(reached("sent")).toBe(true);
		expect(reached("queued")).toBe(true);
		expect(reached("dropped")).toBe(false);
	});
});
