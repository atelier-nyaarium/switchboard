import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import type { ConsoleAssistantStateResult } from "../shared/schemasAssistant.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("the assistant's session through the console", () => {
	let h: FederationHarness;

	const dispatch = async (target: string, op: Parameters<typeof h.phone.deliver>[1]) => {
		const opId = `op-assistant-${op.kind}`;
		expect((await h.phone.deliver(target, op, opId)).outcome).toBe("accepted");
		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find(
					(candidate) => candidate.envelope.kind === "op_result" && candidate.envelope.opKey.opId === opId,
				),
			`dispatch result for ${opId}`,
		);
		return h.phone.open(row) as { ok: boolean; error?: string };
	};
	const assistant = async (op: Parameters<typeof h.phone.value>[0]) =>
		(await h.phone.value(op)).result as ConsoleAssistantStateResult & { ok?: boolean };

	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("lives where the owner places it, and refuses a plain forget", async () => {
		const before = await assistant({ kind: "assistant_state" });
		await assistant({ kind: "assistant_place", workdir: "relative/notes" });
		const refused = await assistant({ kind: "assistant_state" });
		const placed = await assistant({ kind: "assistant_place", workdir: "~/projects/notes" });
		const opsBefore = h.host.ops.length;
		const forgot = await dispatch(ASSISTANT_TEAM, { kind: "forget", target: h.target(ASSISTANT_TEAM) });

		expect(before).toMatchObject({ workdir: null, team: null });
		expect(refused).toMatchObject({ workdir: null, team: null });
		expect(placed).toMatchObject({ workdir: "~/projects/notes", team: ASSISTANT_TEAM });
		expect(placed.watchers.map((watcher) => watcher.id)).toEqual(["github"]);
		expect(forgot.ok, JSON.stringify(forgot)).toBe(false);
		expect(h.host.ops.length).toBe(opsBefore);
	});

	it("grants a watcher its entries, and refuses a watcher it does not know", async () => {
		const granted = await assistant({
			kind: "assistant_watcher_grants",
			watcherId: "github",
			entryIds: ["gh-token"],
		});
		await assistant({ kind: "assistant_watcher_grants", watcherId: "gmail", entryIds: ["x"] });
		await assistant({ kind: "assistant_watcher_grants", watcherId: "github", entryIds: ["a", "b"] });
		const after = await assistant({ kind: "assistant_state" });

		expect(granted.watchers[0]?.grants).toEqual(["gh-token"]);
		expect(after.watchers.map((watcher) => watcher.id)).toEqual(["github"]);
	});

	it("outlives the session sweep that takes an ordinary idle session", async () => {
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Idle",
		});
		const idle = `host.${(result as { id: string }).id}`;
		await new Promise((resolve) => setTimeout(resolve, 5));

		const swept = h.gateway.faults.sweepSessions(0);

		expect(swept).toContain(idle);
		expect(swept).not.toContain(ASSISTANT_TEAM);
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toBeDefined();
	});

	it("leaves on a release, ending its pane and its record", async () => {
		const released = await assistant({ kind: "assistant_release" });

		expect(released).toMatchObject({ workdir: null, team: null });
		expect(h.gateway.faults.sessionRecord(ASSISTANT_TEAM)).toBeUndefined();
		expect(h.host.ops.some((op) => op.kind === "killSession")).toBe(true);
	});
});
