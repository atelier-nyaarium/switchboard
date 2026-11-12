---
name: agents
description: Drives OpenCode, Codex or Copilot agents for you. Use when a task is worth handing to another model family, either as one self-contained piece or several running side by side. Knows how to open, steer, collect and recover agent threads; the prompt decides what they do.
---

# Agent driver

You drive OpenCode, Codex or Copilot agents. The prompt defines their work. This brief explains how to run them.
`backend` sets the backend for `agentStart`. If more than one is installed, you must specify which.

## Running several at once

You can hold more than one agent yourself. Each `agentStart` returns once its agent takes the turn,
so open them all, then collect each with `agentCollect` after its completion notice.

Do not spawn a sub-agent per thread. Measured on the same task, a wrapper agent per thread cost
roughly four times the tokens and found no more: each wrapper spends its budget re-reading the same
sources to decide whether to trust an answer it was told to relay. Doing that once, yourself, over
all of them is both cheaper and better, because you can see them against each other.

Spend what that saves on the collecting step.

## Working a thread

- **Reuse a thread.** Follow up with `agentMessage` rather than starting a fresh agent per
  attempt. A thread that already holds its own last three failures fixes the fourth; a new one
  relearns the problem.
- **Re-task, don't restart.** A thin or unsupported answer is a reason to push back on that same
  thread, naming what was missing. Ask the agent to retract any claim it cannot support.
- **A collect never waits.** It hands back every ended turn not yet collected and names the running
  one. Wait for the completion notice, then collect.
- **Threads outlive their caller.** Keep the ids you will message again: an idle agent with every turn collected leaves
  `agentList`, though `agentList` with `agentId` still finds it. If something dies, collect the
  existing work instead of repeating it.

`agentStart` takes `prompt`; optional fields are `backend`, `model`, `effort` (Copilot), `tier` (Codex),
`schema`, and `cwd`. `agentMessage` takes `agentId` and `prompt`, with optional `schema` and Codex-only
`tier`. `agentCollect` and `agentStop` take `agentId`. `agentList` accepts optional `backend`,
`agentId` and `limit`. `agentListModels` accepts optional `backend`.

## Guardrails are yours to write

Switchboard enforces nothing. An agent holds workspace-write and network access for its whole life,
whatever the prompt says. A goal without guardrails can take it down an unexpected route. Every prompt
you send states, plainly:

- whether it may write at all, and if so which paths
- whether it may reach the network
- what done looks like

A narrow explicit scope gets excellent work out of it. An open brief gets surprises.

## Trust what you can check

Verify what comes back against the source before you rely on it. A confident tone is not evidence,
and a claim you cannot trace to something real is not a result. When you pass an answer along
unverified, say so.

Report negatives too. "I looked and there is nothing here" is a finding, and it is how a reader
calibrates everything else you say.

## One exception

Research, web research especially, stays with Claude rather than going to another agent.
