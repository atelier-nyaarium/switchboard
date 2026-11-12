import { describe, expect, it } from "vitest";
import {
	AGENT_BACKENDS,
	AGENT_WAIT_BUDGET_MS,
	agentCapabilityId,
	agentEnvPrefix,
	agentFrameType,
	agentHttpPath,
	agentInboundFrameTypes,
	CODEX_BACKEND,
	COPILOT_BACKEND,
	OPENCODE_BACKEND,
} from "../shared/agent-backend.js";
import { agentWire } from "../shared/agent-wire.js";
import { CODEX_AGENT_CAPABILITY_ID, COPILOT_AGENT_CAPABILITY_ID } from "../shared/capabilities.js";
import { HARNESS } from "../shared/session-harness.js";

// Every derivation is pinned so a descriptor edit that would change a wire spelling fails here instead of at a peer.
describe("agent backend derivations", () => {
	const copilotWire = agentWire("copilot");

	it("derives the capability ids the gates read", () => {
		expect(agentCapabilityId("codex")).toBe(CODEX_AGENT_CAPABILITY_ID);
		expect(agentCapabilityId("copilot")).toBe(COPILOT_AGENT_CAPABILITY_ID);
		expect(CODEX_AGENT_CAPABILITY_ID).toBe("codex-agent");
		expect(COPILOT_AGENT_CAPABILITY_ID).toBe("copilot-agent");
	});

	it("derives the env prefixes the child-env scrub exempts", () => {
		expect(agentEnvPrefix("codex")).toBe("CODEX_");
		expect(agentEnvPrefix("copilot")).toBe("COPILOT_");
	});

	it("derives the HTTP paths the tools post to", () => {
		expect(agentHttpPath("codex")).toBe("/codex");
		expect(agentHttpPath("copilot")).toBe("/copilot");
	});

	it("derives frame types the wire schemas accept", () => {
		const codexHello = {
			type: agentFrameType("codex", "hello"),
			daemonInstanceId: "daemon-1",
			targets: [],
		};
		expect(agentWire("codex").hello.safeParse(codexHello).success).toBe(true);
		const copilotHello = { ...codexHello, type: agentFrameType("copilot", "hello") };
		expect(copilotWire.hello.safeParse(copilotHello).success).toBe(true);

		const codexAck = {
			type: agentFrameType("codex", "ack"),
			daemonInstanceId: "daemon-1",
			targetId: "host",
			generation: 1,
			throughEventId: 0,
		};
		expect(agentWire("codex").ack.safeParse(codexAck).success).toBe(true);
		const copilotAck = { ...codexAck, type: agentFrameType("copilot", "ack") };
		expect(copilotWire.ack.safeParse(copilotAck).success).toBe(true);
	});

	it("lists exactly the daemon-to-gateway frame types", () => {
		expect([...agentInboundFrameTypes("codex")].sort()).toEqual(["codex_event", "codex_hello", "codex_receipt"]);
		expect([...agentInboundFrameTypes("copilot")].sort()).toEqual([
			"copilot_event",
			"copilot_hello",
			"copilot_receipt",
		]);
	});

	it("keeps the wait budget the tools document", () => {
		expect(CODEX_BACKEND.waitBudgetMs).toBe(240_000);
		expect(COPILOT_BACKEND.waitBudgetMs).toBe(240_000);
		expect(CODEX_BACKEND.waitBudgetMs).toBe(AGENT_WAIT_BUDGET_MS);
		expect(COPILOT_BACKEND.waitBudgetMs).toBe(AGENT_WAIT_BUDGET_MS);
	});

	it("registers each backend once, in the order every list names them", () => {
		expect(AGENT_BACKENDS.map((backend) => backend.id)).toEqual(["opencode", "codex", "copilot"]);
	});

	it("derives OpenCode's names, and looks for its binary where its session CLI is installed", () => {
		expect(agentCapabilityId("opencode")).toBe("opencode-agent");
		expect(agentEnvPrefix("opencode")).toBe("OPENCODE_");
		expect(agentHttpPath("opencode")).toBe("/opencode");
		expect([...agentInboundFrameTypes("opencode")].sort()).toEqual([
			"opencode_event",
			"opencode_hello",
			"opencode_receipt",
		]);
		expect(OPENCODE_BACKEND.binaryName).toBe(HARNESS.opencode.binary.posix);
		expect(OPENCODE_BACKEND.binaryHomeDir).toBe(HARNESS.opencode.binary.homeDir);
	});
});
