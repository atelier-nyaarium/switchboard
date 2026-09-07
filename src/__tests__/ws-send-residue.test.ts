import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.join(import.meta.dirname, "..", "gateway");
const ALLOWLIST = new Map([
	["connectorProxy.ts", "a raw passthrough forwards binary frames it never reads"],
	["routerClient.ts", "the Router link is a client socket, whose send answers nothing"],
]);
// A socket variable is named for what it is, so a `.send(` whose receiver ends in `ws` or `socket`
// is a frame write, through any dotted path. An abstraction that merely exposes `send` is not.
// A socket reached by index or under an unrelated name is not caught.
const socketSend = /(?:[\w$]+\.)*[\w$]*(?:[wW]s|[sS]ocket)[!?]?\s*\.send\s*\(/;

function hasResidue(source: string): boolean {
	return socketSend.test(source);
}

describe("socket write ownership", () => {
	it("has no raw socket writes outside the shared owner", () => {
		const offenders = filesUnder(SRC).filter((file) => {
			// Positive controls.
			if (path.basename(file) === "wsSend.ts" || file === import.meta.filename) return false;
			if (ALLOWLIST.has(path.basename(file))) return false;
			return hasResidue(readFileSync(file, "utf8"));
		});
		expect(offenders).toEqual([]);
	});

	it("matches a raw socket write and spares the abstractions that only look like one", () => {
		expect(hasResidue(["ws.", "send(payload)"].join(""))).toBe(true);
		expect(hasResidue(["hostWs.", "send(JSON.stringify(op))"].join(""))).toBe(true);
		expect(hasResidue(["senderWs.", "send(pushMsg)"].join(""))).toBe(true);
		expect(hasResidue(["ws!.", "send(frame)"].join(""))).toBe(true);
		expect(hasResidue(["clientSocket.", "send(data)"].join(""))).toBe(true);
		expect(hasResidue(["this.ws.", "send(frame)"].join(""))).toBe(true);
		expect(hasResidue(["socket.", "send(data)"].join(""))).toBe(true);
		expect(hasResidue(["this.socket?.", "send(data)"].join(""))).toBe(true);
		expect(hasResidue("sendOn(ws, payload, label)")).toBe(false);
		// Non-socket send.
		expect(hasResidue("await routes.send(FAKE_REQ, body)")).toBe(false);
		expect(hasResidue('await deps.send("key_request", { request })')).toBe(false);
		expect(hasResidue("await this.deps.send(action, params)")).toBe(false);
		expect(hasResidue("\tsend(payload: string): number {")).toBe(false);
		expect(hasResidue("/** the reply the socket send answers with */")).toBe(false);
	});
});
