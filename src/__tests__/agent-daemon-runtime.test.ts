import { afterEach, describe, expect, it } from "vitest";
import { CodexBackendSession } from "../mcp/agents/codexSession.js";
import { CopilotBackendSession } from "../mcp/agents/copilotSession.js";
import { AGENT_DRIVERS } from "../mcp/agents/drivers.js";
import { OpencodeBackendSession } from "../mcp/agents/opencodeSession.js";
import { type AgentDaemonRuntime, createAgentDaemonRuntime } from "../mcp/devcontainer/agentDaemonRuntime.js";
import { AGENT_BACKENDS, type AgentBackendId, agentFrameType } from "../shared/agent-backend.js";
import { agentWire } from "../shared/agent-wire.js";
import { type ScriptedAgents, scriptedAgents } from "../testing/scriptedAgents.js";

const OWNER_KEY = "recipe-app.work";
const HOST_TARGET = { kind: "host", workdirHint: "~" } as const;

type Frame = Record<string, unknown>;

let minted = 0;
function id(): string {
	minted += 1;
	return `123e4567-e89b-42d3-a456-${String(minted).padStart(12, "0")}`;
}

function agentId(backend: AgentBackendId): string {
	return `${backend}_${"0123456789abcdef".repeat(2)}`;
}

function startCommand(backend: AgentBackendId, prompt = "go"): Frame {
	return agentWire(backend).command.parse({
		type: agentFrameType(backend, "command"),
		requestId: id(),
		ownerKey: OWNER_KEY,
		agentId: agentId(backend),
		kind: "start",
		operationId: id(),
		target: HOST_TARGET,
		prompt,
	});
}

async function until(probe: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!probe()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("agent daemon runtime", () => {
	let runtime: AgentDaemonRuntime;
	let agents: ScriptedAgents;
	let sent: Frame[];

	const setup = (): void => {
		agents = scriptedAgents();
		sent = [];
		runtime = createAgentDaemonRuntime({
			daemonInstanceId: "daemon-1",
			send: (frame) => sent.push(frame),
			resolveHostCwd: () => "/home/fixture",
			drivers: agents.drivers,
			log: () => () => {},
			clock: agents.clock,
		});
	};
	const terminals = (backend: AgentBackendId): Frame[] =>
		sent.filter((frame) => frame.type === agentFrameType(backend, "event") && frame.kind === "terminal");

	afterEach(() => runtime.shutdown());

	it("says hello for every backend on connect, each followed by what the Gateway never acknowledged", async () => {
		setup();
		expect(runtime.receive(startCommand("copilot"))).toBe(true);
		await until(() => terminals("copilot").length === 1, "the copilot turn's end");
		const reliable = sent.filter((frame) => frame.kind === "accepted" || frame.kind === "terminal");

		sent.length = 0;
		runtime.connected();

		const hellos = sent.filter((frame) => String(frame.type).endsWith("_hello"));
		expect(hellos.map((frame) => frame.type)).toEqual(AGENT_BACKENDS.map(({ id }) => agentFrameType(id, "hello")));
		for (const { id } of AGENT_BACKENDS) expect(agentWire(id).hello.safeParse(hellos.shift()).success).toBe(true);
		const copilotHello = sent.findIndex((frame) => frame.type === agentFrameType("copilot", "hello"));
		expect(sent.slice(copilotHello + 1, copilotHello + 1 + reliable.length)).toEqual(reliable);
	});

	it("replays nothing the Gateway acknowledged", async () => {
		setup();
		runtime.receive(startCommand("codex"));
		await until(() => terminals("codex").length === 1, "the codex turn's end");
		const terminal = terminals("codex")[0] as { targetId: string; generation: number; eventId: number };

		const acknowledged = runtime.receive({
			type: agentFrameType("codex", "ack"),
			daemonInstanceId: "daemon-1",
			targetId: terminal.targetId,
			generation: terminal.generation,
			throughEventId: terminal.eventId,
		});
		sent.length = 0;
		runtime.connected();

		expect(acknowledged).toBe(true);
		expect(sent.every((frame) => String(frame.type).endsWith("_hello"))).toBe(true);
	});

	it("keeps what an acknowledgement for another daemon's stream names", async () => {
		setup();
		runtime.receive(startCommand("codex"));
		await until(() => terminals("codex").length === 1, "the codex turn's end");
		const terminal = terminals("codex")[0] as { targetId: string; generation: number; eventId: number };

		runtime.receive({
			type: agentFrameType("codex", "ack"),
			daemonInstanceId: "daemon-0",
			targetId: terminal.targetId,
			generation: terminal.generation,
			throughEventId: terminal.eventId,
		});
		sent.length = 0;
		runtime.connected();

		expect(sent.filter((frame) => frame.kind === "terminal")).toHaveLength(1);
	});

	it("routes a command to its own backend alone, and leaves any other frame to the caller", async () => {
		setup();
		runtime.receive(startCommand("opencode", "only here"));
		await until(() => terminals("opencode").length === 1, "the opencode turn's end");

		expect(agents.of("opencode").turns.map((turn) => turn.prompt)).toEqual(["only here"]);
		expect(agents.of("codex").turns).toEqual([]);
		expect(agents.of("copilot").turns).toEqual([]);
		expect(runtime.receive({ type: "wake", team: "host.work" })).toBe(false);
	});

	it("lists a backend's models through that backend's own child", async () => {
		setup();
		agents.of("codex").models = ["gpt-luna", "gpt-sol"];

		const listed = await runtime.listModels("codex", HOST_TARGET);

		expect(listed).toMatchObject({ kind: "listed" });
		expect(JSON.stringify(listed)).toContain("gpt-sol");
		expect(agents.of("copilot").launches).toBe(0);
	});

	it("places the runtime only for a backend whose child is this build's own entry point", async () => {
		agents = scriptedAgents();
		sent = [];
		const placed: string[] = [];
		runtime = createAgentDaemonRuntime({
			daemonInstanceId: "daemon-1",
			send: (frame) => sent.push(frame),
			resolveHostCwd: () => "/home/fixture",
			drivers: agents.drivers,
			placeRuntime: async (target) => {
				placed.push(target.targetId);
			},
			log: () => () => {},
			clock: agents.clock,
		});

		runtime.receive(startCommand("codex"));
		runtime.receive(startCommand("opencode"));
		await until(() => terminals("codex").length === 1 && terminals("opencode").length === 1, "both turns' ends");

		expect(placed).toEqual(["host"]);
		expect(agents.of("opencode").launches).toBe(1);
	});
});

describe("scripted backends", () => {
	const REAL = {
		codex: CodexBackendSession,
		copilot: CopilotBackendSession,
		opencode: OpencodeBackendSession,
	} as const;
	const OPTIONAL = [
		"resumeThread",
		"steerTurn",
		"inspectTurn",
		"adoptTurn",
		"listModels",
		"onCounter",
		"onProgress",
		"busy",
	] as const;

	it.each(AGENT_BACKENDS.map(({ id }) => id))("offer the optional methods the real %s session offers", async (id) => {
		const { drivers } = scriptedAgents();
		const child = drivers[id].launcher.launch({ kind: "host", targetId: "host", cwd: "/home/fixture" }, {});
		const scripted = await drivers[id].open(child);

		const offered = OPTIONAL.filter((method) => typeof scripted[method] === "function");

		expect(offered).toEqual(OPTIONAL.filter((method) => method in REAL[id].prototype));
		expect(drivers[id].threadsResumable).toBe(AGENT_DRIVERS[id].threadsResumable);
		expect(drivers[id].ownRuntime).toBe(AGENT_DRIVERS[id].ownRuntime);
	});
});
