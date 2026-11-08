import { describe, expect, it } from "vitest";
import { type AgentCatalog, AgentCatalogPersistence } from "../gateway/agentCatalogPersistence.js";
import { AgentTransitionError } from "../gateway/agentRouteEnvelope.js";
import { withTurnMarks } from "../shared/agent-turn-marks.js";
import type { SessionRecord } from "../shared/session-store.js";

interface TestAgent {
	agentId: string;
	agentState: string;
	operations: Array<{ operationId: string; fingerprint: string; state: string }>;
	turns: Array<{ id: string; state: string }>;
	turnMarks?: { collected: string[]; notified: string[] };
}

function agent(agentId: string, state = "requested"): TestAgent {
	return {
		agentId,
		agentState: "idle",
		operations: [{ operationId: `op-${agentId}`, fingerprint: "f", state }],
		turns: [],
	};
}

type Write = "lands" | "conflicts" | "orphaned" | "throws";
type Checkpoint = "durable" | "confirms" | "refuses" | "throws";

function setup(write: Write = "lands", agents = [agent("a"), agent("b")], checkpoint: Checkpoint = "durable") {
	const owner = {} as SessionRecord;
	let catalog: AgentCatalog<TestAgent> = { version: 1, revision: 1, agents };
	const persistence = new AgentCatalogPersistence<TestAgent>({
		read: () => catalog,
		writer: {
			commit: (_owner, _expected, next) => {
				if (write === "throws") throw new Error("disk full");
				if (write === "conflicts") return { committed: false, reason: "revision_conflict" };
				if (write === "orphaned") return { committed: false, reason: "owner_missing" };
				catalog = { version: 1, revision: catalog.revision + 1, agents: [...next] };
				return { committed: true, catalog };
			},
			isDurable: () => checkpoint === "durable",
			checkpoint: () => {
				if (checkpoint === "throws") throw new Error("disk full");
				return checkpoint === "refuses"
					? { confirmed: false, reason: "revision_conflict" }
					: { confirmed: true, catalog };
			},
		},
	});
	return { owner, persistence };
}

function refusalOf(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof AgentTransitionError ? error.code : "other";
	}
	return undefined;
}

describe("agent catalog persistence", () => {
	it("applies a daemon change, and holds it for reconciliation when the write does not land", () => {
		const landed = setup("lands");
		expect(landed.persistence.apply(landed.owner, agent("b", "accepted"))).toMatchObject({
			disposition: "applied",
			catalogRevision: 2,
		});
		const states = ["a", "b"].map((id) => landed.persistence.find(landed.owner, id)?.operations[0]?.state);
		expect(states).toEqual(["requested", "accepted"]);

		for (const write of ["conflicts", "orphaned", "throws"] as const) {
			const held = setup(write);
			expect(held.persistence.apply(held.owner, agent("b", "accepted")).disposition).toBe("reconcile");
		}
		expect(landed.persistence.apply(landed.owner, agent("gone")).disposition).toBe("ignored");
	});

	it("refuses a transition whose write does not land, naming a lost owner as not found", () => {
		const expected: Record<Exclude<Write, "lands">, string> = {
			conflicts: "persistence_failed",
			throws: "persistence_failed",
			orphaned: "not_found",
		};
		for (const [write, code] of Object.entries(expected) as Array<[Exclude<Write, "lands">, string]>) {
			const context = setup(write);
			const catalog = context.persistence.read(context.owner);
			const next = agent("c");
			expect(
				refusalOf(() =>
					context.persistence.commit(context.owner, catalog, [...catalog.agents, next], next, "op-c"),
				),
			).toBe(code);
		}
	});

	it("counts a catalog durable only once the writer or a checkpoint confirms it", () => {
		const verdicts = (["durable", "confirms", "refuses", "throws"] as const).map((checkpoint) => {
			const context = setup("lands", undefined, checkpoint);
			return context.persistence.durable(context.owner, 1);
		});
		expect(verdicts).toEqual([true, true, false, false]);
	});

	it("resolves an agent only when exactly one entry carries its id", () => {
		const context = setup("lands", [agent("a"), agent("a"), agent("b")]);
		const catalog = context.persistence.read(context.owner);
		expect(context.persistence.find(context.owner, "a")).toBeUndefined();
		expect(refusalOf(() => context.persistence.indexOf(catalog, "a"))).toBe("not_found");
		expect(context.persistence.indexOf(catalog, "b")).toBe(2);
		expect(context.persistence.apply(context.owner, agent("a", "accepted")).disposition).toBe("ignored");
	});

	it("retires only agents without a running turn or requested operation", () => {
		const idle = setup("lands", [agent("idle", "accepted")]);
		expect(idle.persistence.retire(idle.owner, "idle")).toMatchObject({ retired: true });
		expect(idle.persistence.find(idle.owner, "idle")).toBeUndefined();

		const working = setup("lands", [
			{ ...agent("working", "accepted"), turns: [{ id: "t1", state: "inProgress" }] },
		]);
		expect(working.persistence.retire(working.owner, "working")).toEqual({ retired: false, reason: "active_turn" });
		expect(working.persistence.find(working.owner, "working")).toBeDefined();

		const requested = setup("lands", [{ ...agent("requested"), agentState: "unavailable" }]);
		expect(requested.persistence.retire(requested.owner, "requested")).toEqual({
			retired: false,
			reason: "requested_operation",
		});
	});

	it("collects every ended turn once, replays a repeated collect, and refuses a write it cannot land", () => {
		const turns = [
			{ id: "t1", state: "completed" },
			{ id: "t2", state: "failed" },
			{ id: "t3", state: "inProgress" },
		];
		const parse = (candidate: unknown) => candidate as TestAgent;
		const held = setup("lands", [{ ...agent("a", "accepted"), turns }]);
		expect(held.persistence.collect(held.owner, "a", "op-1", parse)?.turnIds).toEqual(["t1", "t2"]);
		expect(held.persistence.collect(held.owner, "a", "op-1", parse)?.turnIds).toEqual(["t1", "t2"]);
		expect(held.persistence.collect(held.owner, "a", "op-2", parse)?.turnIds).toEqual([]);
		expect(held.persistence.collect(held.owner, "a", "op-1", parse)?.turnIds).toEqual(["t1", "t2"]);
		expect(held.persistence.find(held.owner, "a")?.turnMarks).toMatchObject({
			collected: ["t1", "t2"],
			notified: ["t1", "t2"],
		});
		expect(held.persistence.collect(held.owner, "missing", "op-3", parse)).toBeUndefined();

		const stuck = setup("conflicts", [{ ...agent("a", "accepted"), turns }]);
		expect(() => stuck.persistence.collect(stuck.owner, "a", "op-1", parse)).toThrow(AgentTransitionError);
		expect(stuck.persistence.markNotified(stuck.owner, "a", "t1", parse)).toBe(false);
	});

	it("restores an agent stored before marks with its ended turns collected and told, and keeps stored marks", () => {
		const legacy = {
			agentState: "idle",
			turns: [
				{ id: "t1", state: "completed" },
				{ id: "t2", state: "inProgress" },
			],
		};
		expect(withTurnMarks(legacy)).toMatchObject({ turnMarks: { collected: ["t1"], notified: ["t1"] } });
		const marked = { ...legacy, turnMarks: { collected: [], notified: ["t1"] } };
		expect(withTurnMarks(marked)).toBe(marked);
	});
});
