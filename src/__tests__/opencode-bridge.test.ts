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
async function plugin(held: { state: DerivedPresence }) {
	vi.resetModules();
	const bridge = await import("../mcp/bridge/helpers.js");
	bridge.initBridge({
		routerUrl: "http://localhost:20000",
		projectName: "host.oc",
		profile: pluginProfile("opencode"),
	});
	bridge.setApiSession({ current: () => held.state } as unknown as ApiSession);
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
	it.each([
		["ends", true],
		["begins and ends", false],
	])(
		"hands the Gateway one edge after a reconnect for a compaction that %s while the socket was down",
		async (_label, startedBefore) => {
			const held = { state: busy };
			live = await plugin(held);
			const first = connected(live);
			live.reportSessionPresence(startedBefore ? { ...busy, compacting: true } : busy);

			drop(first);
			if (!startedBefore) live.reportSessionPresence({ ...busy, compacting: true });
			held.state = idle;
			live.reportSessionPresence(idle);
			const second = connected(live);

			expect(presence(second)).toEqual([{ ...idle, compacting: true }, idle]);
		},
	);

	it("owes nothing from a fresh plugin process", async () => {
		const before = await plugin({ state: busy });
		const first = connected(before);
		before.reportSessionPresence({ ...busy, compacting: true });
		drop(first);
		before.closeRouter();

		live = await plugin({ state: idle });
		const second = connected(live);

		expect(presence(second)).toEqual([idle]);
	});

	it("resends only the held state when nothing compacted while it was down", async () => {
		const held = { state: busy };
		live = await plugin(held);
		const first = connected(live);
		live.reportSessionPresence(busy);

		drop(first);
		held.state = idle;
		live.reportSessionPresence(idle);
		const second = connected(live);

		expect(presence(second)).toEqual([idle]);
	});
});
