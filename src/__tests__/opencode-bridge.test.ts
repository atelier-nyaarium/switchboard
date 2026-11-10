import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiSession } from "../mcp/opencode/session.js";
import { pluginProfile } from "../mcp/sessionCli.js";
import type { DerivedPresence } from "../shared/schemasPresence.js";
import { SESSION_PRESENCE_FRAME } from "../shared/session-control.js";

interface FakeWs {
	readyState: number;
	sent: string[];
	emit(event: string, value?: unknown): void;
}

const sockets = vi.hoisted(() => ({ made: [] as FakeWs[] }));

vi.mock("ws", () => {
	class FakeSocket {
		static OPEN = 1;
		readyState = 0;
		sent: string[] = [];
		private listeners = new Map<string, Array<(value?: unknown) => void>>();
		constructor() {
			sockets.made.push(this as unknown as FakeWs);
		}
		on(event: string, listener: (value?: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
		send(value: string): void {
			this.sent.push(value);
		}
		close(): void {
			this.readyState = 3;
		}
		emit(event: string, value?: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) listener(value);
		}
	}
	return { default: FakeSocket };
});

const idle: DerivedPresence = { working: false, needsLogin: false, limitBlocked: false };
const busy: DerivedPresence = { ...idle, working: true };

/** A fresh plugin process. */
async function plugin(held: { state: DerivedPresence; registrations: number }) {
	vi.resetModules();
	const bridge = await import("../mcp/bridge/helpers.js");
	bridge.initBridge({
		routerUrl: "http://localhost:20000",
		projectName: "host.oc",
		profile: pluginProfile("opencode"),
	});
	bridge.setApiSession({
		current: () => held.state,
		registered: () => {
			held.registrations += 1;
		},
	} as unknown as ApiSession);
	return bridge;
}

/** A socket up and registered. */
function connected(bridge: Awaited<ReturnType<typeof plugin>>): FakeWs {
	bridge.connectToRouter();
	const socket = sockets.made.at(-1) as FakeWs;
	socket.readyState = 1;
	socket.emit("open");
	socket.emit("message", JSON.stringify({ type: "register_ok" }));
	return socket;
}

function drop(socket: FakeWs): void {
	socket.readyState = 3;
	socket.emit("close");
}

const presence = (socket: FakeWs) =>
	socket.sent
		.map((text) => JSON.parse(text) as Record<string, unknown>)
		.filter((frame) => frame.type === SESSION_PRESENCE_FRAME)
		.map(({ type: _type, ...fields }) => fields);

let live: Awaited<ReturnType<typeof plugin>> | undefined;
afterEach(() => {
	live?.closeRouter();
	live = undefined;
	sockets.made = [];
});

describe("a plugin-read session's state across its Gateway socket", () => {
	it("resends the held state once on a reconnect, and tells its session it registered again", async () => {
		const held = { state: busy, registrations: 0 };
		live = await plugin(held);
		const first = connected(live);
		live.reportSessionPresence({ ...busy, compacting: true });

		drop(first);
		held.state = idle;
		live.reportSessionPresence(idle);
		const second = connected(live);

		expect(presence(first)).toEqual([busy, { ...busy, compacting: true }]);
		expect(presence(second)).toEqual([idle]);
		expect(held.registrations).toBe(2);
	});
});
