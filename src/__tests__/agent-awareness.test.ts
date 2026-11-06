import { describe, expect, it } from "vitest";
import { agentAwarenessSubscriber, createAgentWatch, type RosterAgent } from "../gateway/agentAwareness.js";
import type { AgentNotice } from "../shared/agent-notice.js";

function harness(roster: RosterAgent[], start = 100, takesProgress?: (ownerKey: string) => boolean) {
	const clock = { now: start };
	const notices: AgentNotice[] = [];
	const lines: string[] = [];
	const watch = createAgentWatch({
		roster: () => roster,
		now: () => clock.now,
		everyMs: 10,
		takesProgress,
		observe(observations) {
			notices.push(...observations.flatMap(({ post }) => (post ? [post] : [])));
			lines.push(
				agentAwarenessSubscriber.render(
					"owner",
					observations.map(({ identity, pre, post }) => ({ identity, pre, post })),
				),
			);
		},
	});
	const done = () => notices.filter((notice) => notice.kind === "done");
	return { clock, notices, lines, watch, done };
}

function agent(agentId: string, family: "codex" | "copilot", agentState: string, turns: RosterAgent["turns"]) {
	return { ownerKey: "owner", family, agentId, agentState, turns } as RosterAgent;
}

describe("agent awareness", () => {
	it("skips history, tells each completion once, and paces progress with the newest notes", () => {
		const old = agent("codex-old", "codex", "idle", [{ id: "old", state: "completed", updatedAt: 50, notes: [] }]);
		const codex = agent("codex-running", "codex", "working", [
			{ id: "c1", state: "inProgress", updatedAt: 100, notes: [] },
		]);
		const copilot = agent("copilot-running", "copilot", "working", [
			{ id: "p1", state: "inProgress", updatedAt: 100, notes: ["copilot note"] },
		]);
		const { clock, notices, lines, watch, done } = harness([old, codex, copilot]);

		watch.tick();
		clock.now = 109;
		watch.tick();
		expect(notices).toEqual([]);

		codex.turns = [{ id: "c1", state: "inProgress", updatedAt: 110, notes: ["older", "old", "middle", "latest"] }];
		clock.now = 110;
		watch.tick();
		expect(notices.map((notice) => notice.kind)).toEqual(["progress", "progress"]);
		expect(lines.at(-1)).toContain("Latest notes:\n- old\n- middle\n- latest");
		expect(lines.at(-1)).not.toContain("older");

		codex.turns = [{ id: "c1", state: "completed", updatedAt: 120, notes: [] }];
		copilot.agentState = "unavailable";
		clock.now = 120;
		watch.tick();
		watch.tick();

		expect(done()).toEqual([
			{ kind: "done", family: "codex", agentId: "codex-running", outcome: "completed" },
			{ kind: "done", family: "copilot", agentId: "copilot-running", outcome: "unavailable" },
		]);
		expect(lines.join("\n")).toContain("codexCollectAgent");
		expect(lines.join("\n")).toContain("copilotCollectAgent");
	});

	it("tells a turn that settled while the watch was down, but not one settled before", () => {
		const codex = agent("codex-a", "codex", "idle", [
			{ id: "before", state: "completed", updatedAt: 90, notes: [] },
			{ id: "downtime", state: "completed", updatedAt: 100, notes: [] },
		]);
		const { watch, done } = harness([codex], 100);

		watch.tick();

		expect(done()).toEqual([{ kind: "done", family: "codex", agentId: "codex-a", outcome: "completed" }]);
	});

	it("keeps two quick completions of one agent apart", () => {
		const codex = agent("codex-a", "codex", "idle", [
			{ id: "t1", state: "completed", updatedAt: 110, notes: [] },
			{ id: "t2", state: "failed", updatedAt: 112, notes: [] },
		]);
		const observed: string[] = [];
		const watch = createAgentWatch({
			roster: () => [codex],
			now: () => 100,
			observe: (observations) => observed.push(...observations.map((observation) => observation.identity)),
		});

		watch.tick();

		expect(new Set(observed).size).toBe(2);
	});

	it("waits out a recovering agent and tells the turn's real end", () => {
		const codex = agent("codex-a", "codex", "working", [
			{ id: "t1", state: "inProgress", updatedAt: 100, notes: [] },
		]);
		const { watch, done } = harness([codex]);

		watch.tick();
		codex.agentState = "recovering";
		watch.tick();
		expect(done()).toEqual([]);

		codex.agentState = "idle";
		codex.turns = [{ id: "t1", state: "completed", updatedAt: 130, notes: [] }];
		watch.tick();
		expect(done()).toEqual([{ kind: "done", family: "codex", agentId: "codex-a", outcome: "completed" }]);
	});

	it("tells an owner that takes no progress only the completion", () => {
		const codex = agent("codex-a", "codex", "working", [
			{ id: "t1", state: "inProgress", updatedAt: 100, notes: ["note"] },
		]);
		const { clock, notices, watch } = harness([codex], 100, (ownerKey) => ownerKey !== "owner");

		watch.tick();
		clock.now = 130;
		watch.tick();
		codex.turns = [{ id: "t1", state: "completed", updatedAt: 140, notes: [] }];
		clock.now = 140;
		watch.tick();

		expect(notices.map((notice) => notice.kind)).toEqual(["done"]);
	});
});
