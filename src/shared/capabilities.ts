import type { z } from "zod";
import { AGENT_BACKENDS, type AgentBackendId, agentCapabilityId } from "./agent-backend.js";
import { isAgentBackendInstalled, isBinaryOnPath } from "./agent-binary.js";
import type { CapabilityBundleSchema, CapabilitySnapshotSchema, EnabledPluginSchema } from "./schemas.js";

////////////////////////////////
//  Interfaces & Types

export type Capability = z.infer<typeof EnabledPluginSchema>;
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;
export type CapabilityBundle = z.infer<typeof CapabilityBundleSchema>;

////////////////////////////////
//  Functions & Helpers

/** A source that has never spoken. Distinct from one that spoke and declared nothing. */
export const UNREPORTED_CAPABILITIES: CapabilitySnapshot = { known: false, capabilities: [], clientVersions: [] };

export const CODEX_AGENT_CAPABILITY_ID = agentCapabilityId("codex");
export const COPILOT_AGENT_CAPABILITY_ID = agentCapabilityId("copilot");

export const WORKFLOW_INSTRUCTIONS = `
# Workflow

Tools: \`workflowStart\`, \`workflowCollect\`, \`workflowList\` (find run ids), \`workflowStop\` (cancel). Scripts return JSON. \`parallel\`, \`pipeline\`, \`phase\`, \`log\`, \`args\`, and \`label\` follow Workflow. Steps use Codex, Copilot or \`claude -p\`. A backend without its CLI fails as \`unavailable\`.

\`agent(prompt, options)\`: \`backend\` defaults to the run's backend; \`model\` id; \`effort\` (Copilot and Claude); \`tier\` (Codex); \`thread\` reuses an agent; \`skills\` paths prepend to the prompt; \`schema\` validates the answer. Start takes \`scriptPath\`, \`args\`, \`backend\`, \`resumeFrom\`.

Schema dialect: every property required; \`additionalProperties: false\`; nullable via \`["string", "null"]\`. Failed steps return null; collect shows outcome and reason.

Outcomes: completed, invalid, failed, interrupted, lost, declined, rejected, unavailable. Checkups every 10 minutes; settle notices name \`workflowCollect\`. Caps: 4 runs per session, 8 concurrent dispatches, 200 calls per run. Runs and journals survive Gateway restarts.
`.trim();

// Served by capabilityGuidance.
export const AGENT_TOOLS_INSTRUCTIONS = `
# Agents

Delegate a self-contained task with \`agentStart\`.

Tools: \`agentStart\`, \`agentMessage\`, \`agentCollect\`, \`agentStop\`, and \`agentList\`.

\`agentStart.backend\` selects an enabled backend and defaults to the first enabled one. \`agentMessage\`, \`agentCollect\`, and \`agentStop\` infer it from \`agentId\`. \`agentList\` accepts optional \`backend\` and \`agentId\`; \`detail\` and \`limit\` apply to Codex.

\`agentStart\` accepts \`model\`, \`cwd\`, and \`schema\`, plus Copilot-only \`effort\` or Codex-only \`tier\`. \`agentMessage\` accepts \`schema\` and Codex-only \`tier\`.

\`schema\` constrains a new turn's final answer; validate the returned text yourself.

Agents have full access. State allowed writes, network access, and completion criteria in every prompt.

GPT-family agents are **very literal** and pursue a goal through unexpected or suspect actions. Set guardrails in the prompt you delegate.
But, choose your terms **very literally**, because if you say "Never" in the beginning, GPT might not listen to you even if you say "It's OK now".
- "Don't XXX." - Means you will never lift the restriction. Trashing the thread is the only way around.
- "Don't XXX, unless I say otherwise later" - Means you may lift the restriction depending on feel.

You are the triage gate for what an agent says and does. A confident tone is not evidence; verify their work and claims against the code.

## Driving Agents From a Workflow

To keep your context free of clutter, it's recommended to use Workflows.

Code editing or fan-outs run on an agent: Audits, assessments, adversarial second reads.

Research is the exception, web research especially. It stays on Opus.

Choose model depending on task:
- Haiku relays verbatim to the agent. Or Sonnet if you want to remove a whole report phase.
- Sonnet collates, Opus decides.

Single Iterative Phase Style:
- Iterative fix until pass (Sonnet working with agents) and report

Fan Out ► Join Style
- Research (Opuses) ► Rank Sort (Opus or Sonnet)
- Audits (Haikus verbatim agents) ► Synthesize (Opus)
- Assessments (Haikus verbatim agents) ► Synthesize (Opus)

## Recovery

Agents belong to the whole Claude Code session. A terminal result means finished. \`agent_dead\` means the agent cannot run. \`agent_unreachable\` means its process may still be running, so do not duplicate the work. If a Workflow caller dies, \`agentList\` returns a summary; pass \`agentId\` for one agent's full history.
`.trim();

export const CODEX_AGENT_INSTRUCTIONS = `
## Codex

\`model\`, spelled exactly:
- \`gpt-6-luna\` - Default. Exploration, audits, implementation.
- \`gpt-6.1-sol\` - Hardest reasoning and coding. Ask permission first.

If both \`model\` and \`tier\` are omitted, Codex uses \`gpt-6-luna\` at \`priority\`.

\`tier\` accepts \`priority\` or \`standard\`. \`priority\` runs faster and uses more. A Codex \`agentMessage\` tier applies to the next new turn.
`.trim();

export const VAULT_INSTRUCTIONS = `
# Vault

The owner's secrets, approved per use from the phone. No tool ever answers a value.

- \`vault_search\` lists entries by public title and description with their ids.
- \`vault_run\` runs a shell command with one entry's value injected: as \`$VAULT_VALUE\` (or the env name you choose), on stdin followed by a newline, or as a 0600 file at \`$VAULT_FILE\` on tmpfs when there is one. Naming an entry asks the owner to approve the command, so name the real one; a vague command earns a denial.
- A run that outlives the wait (230 seconds per call) answers \`pending\` (the owner has not answered) or \`running\` (the command has not exited). \`vault_collect\` with the \`jobId\` continues it; \`vault_withdraw\` gives the request up.
- A \`refused\` answer with a \`note\` is the owner steering you. Do what the note says instead of asking again.
- \`capture\` on a run stores the command's stdout as a new entry the owner can edit on the phone. Use it to generate a secret that must never enter the transcript.
- \`sudo -A\` forwards the password request through Switchboard to the owner; plain \`sudo\` refuses with no terminal and never asks.
- Run privileged commands individually, each as \`sudo -A <command>\` without a wrapper (like \`-c\` or a script). The owner approves the line the phone shows, and a policy can only match a real command.

stdout and stderr come back with the value's bytes replaced by \`[vault]\`. Never echo a value into a file the transcript can read, and never put it on a command line: \`ps\` shows argv.
`.trim();

export const COPILOT_AGENT_INSTRUCTIONS = `
## Copilot

\`effort\` must be offered by the selected model.
`.trim();

/** A locally served agent backend: a session-made entry with no declared text. */
export function localAgentCapability(id: AgentBackendId): Capability {
	return { id: agentCapabilityId(id) };
}

export function isLocalAgentCapability(capability: Capability): boolean {
	return (
		capability.instructions === undefined && AGENT_BACKENDS.some((b) => agentCapabilityId(b.id) === capability.id)
	);
}

export const AGENT_BACKEND_INSTRUCTIONS: Record<AgentBackendId, string> = {
	codex: CODEX_AGENT_INSTRUCTIONS,
	copilot: COPILOT_AGENT_INSTRUCTIONS,
};

/**
 * What the daemon can actually run, probed rather than configured.
 *
 * A backend's CLI being installed is the whole opt-in: an owner who installed Codex wants Codex, and
 * an extra flag in a file only this repo knows about could only ever disagree with that. An empty
 * array is an affirmative "nothing available" rather than silence, which is what lets a daemon that
 * lost a binary replace a declaration it made while the CLI was there.
 */
export function daemonCapabilityDeclaration(env: Record<string, string | undefined>): Capability[] {
	const capabilities = AGENT_BACKENDS.flatMap((backend) =>
		isAgentBackendInstalled(backend, env)
			? [{ id: agentCapabilityId(backend.id), instructions: AGENT_BACKEND_INSTRUCTIONS[backend.id] }]
			: [],
	);
	return capabilities.length > 0 || isBinaryOnPath("claude", env)
		? [...capabilities, { id: "workflow", instructions: WORKFLOW_INSTRUCTIONS }]
		: capabilities;
}

/**
 * The bundle flattened for a consumer that only needs the list.
 *
 * `known` is an AND: a source that has said nothing leaves the answer silent about the ids only it
 * reports, and calling that complete is what lets one source's empty declaration answer for another.
 * Ids are disjoint by ownership, so first-wins on a collision only settles a misconfiguration.
 */
export function unionCapabilities(bundle: CapabilityBundle): CapabilitySnapshot {
	const sections = [bundle.console, bundle.daemon];
	const byId = new Map<string, Capability>();
	for (const section of sections) {
		for (const capability of section.capabilities) {
			if (!byId.has(capability.id)) byId.set(capability.id, capability);
		}
	}
	return {
		known: sections.every((s) => s.known),
		capabilities: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
		clientVersions: [...new Set(sections.flatMap((s) => s.clientVersions))].sort(),
	};
}
