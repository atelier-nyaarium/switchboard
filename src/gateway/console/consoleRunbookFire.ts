import type { ConsoleOp } from "../../shared/console-protocol.js";
import { launchFailureText } from "../../shared/launch-notice.js";
import { renderRunbook } from "../../shared/runbook-grammar.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";
import type { CliPick, SessionHarness } from "../../shared/session-harness.js";
import { composeSessionName } from "../../shared/session-id.js";
import type { WakeResult } from "../wake.js";
import type { ConsoleTargets } from "./consoleTargets.js";

export interface RunbookFireResult {
	fired: boolean;
	sessionId?: string;
	reason?: string;
}

/** Who is firing, so the message reaches the session as the owner's own. */
export interface RunbookFireContext {
	conversationId: string;
	opId: string;
	device: string;
	ownerId: string;
}

export interface RunbookFireDeps {
	targets: ConsoleTargets;
	getRunbook?: (runbookId: string) => Runbook | null;
	createSession: (
		op: Extract<ConsoleOp, { kind: "create_session" }>,
		conversationId: string,
		opId: string,
		internal?: { unpicked: true },
	) => Promise<{ id: string; status?: "pending" }>;
	awaitRegister?: (team: string) => Promise<WakeResult>;
	deliver: (to: string, body: string, ctx: RunbookFireContext) => Promise<{ ok: boolean; error?: string }>;
	/** The CLI a new session runs, or why none. */
	pick: (spawn: string, pick: CliPick | undefined) => { harness?: SessionHarness } | { refused: string };
}

export function createRunbookFireHandler({
	targets,
	getRunbook,
	createSession,
	awaitRegister,
	deliver,
	pick,
}: RunbookFireDeps) {
	/** Launch and send share no ordering, so registration comes before the body goes out. */
	async function intoNewSession(
		into: Extract<ConsoleOp, { kind: "runbook_fire" }>["into"] & { kind: "new" },
		runbook: Pick<Runbook, "name">,
		ctx: RunbookFireContext,
	): Promise<{ team: string; sessionId: string } | RunbookFireResult> {
		const chosen = pick(targets.localSpawn(into.target), into.cli);
		if ("refused" in chosen) return { fired: false, reason: chosen.refused };
		const created = await createSession(
			{
				kind: "create_session",
				target: into.target,
				displayLabel: into.displayLabel ?? runbook.name,
				workdir: into.workdir,
				...(chosen.harness ? { harness: chosen.harness } : {}),
			},
			ctx.conversationId,
			ctx.opId,
			chosen.harness ? undefined : { unpicked: true },
		);
		const tmux = targets.tmuxTarget(into.target, created.id);
		const team = composeSessionName(tmux.name, tmux.sessionName);
		if (!awaitRegister) {
			return {
				fired: false,
				sessionId: created.id,
				reason: "this Gateway cannot wait for a new session; fire into one already running",
			};
		}
		const registered = await awaitRegister(team);
		if (!registered.ok && registered.failure) {
			const reason = launchFailureText(registered.failure, created.id, { created: true, foreign: false });
			return { fired: false, sessionId: created.id, reason };
		}
		if (!registered.ok) {
			console.warn(`[runbook] ${team} started but never registered (${registered.errorKind ?? "timeout"})`);
			return {
				fired: false,
				sessionId: created.id,
				reason: `"${created.id}" started but is not listening yet; fire at it again in a moment`,
			};
		}
		return { team, sessionId: created.id };
	}

	/** The one road from a stored id and values to text, so a preview cannot differ from a fire. */
	function textOf(runbookId: string, values: Readonly<Record<string, string>>) {
		if (!getRunbook) throw new Error("runbooks are not available on this Gateway");
		const runbook = getRunbook(runbookId);
		if (!runbook) return { reason: `no runbook "${runbookId}" on this Gateway`, revision: 0 };
		// A stored record is checked again here, so a rule it no longer passes reaches the owner.
		const refusal = runbookRefusal(runbook);
		if (refusal) return { reason: refusal, revision: runbook.revision };

		const rendered = renderRunbook(runbook.body, runbook.parameters, values);
		if (!rendered.ok) return { reason: rendered.reason, revision: runbook.revision };
		return { runbook, text: rendered.text, revision: runbook.revision };
	}

	function preview(op: Extract<ConsoleOp, { kind: "runbook_preview" }>) {
		const made = textOf(op.runbookId, op.values);
		return made.text === undefined
			? { revision: made.revision, reason: made.reason }
			: { revision: made.revision, text: made.text };
	}

	async function fire(
		op: Extract<ConsoleOp, { kind: "runbook_fire" }>,
		ctx: RunbookFireContext,
	): Promise<RunbookFireResult> {
		const made = textOf(op.runbookId, op.values);
		if (made.text === undefined || !made.runbook) return { fired: false, reason: made.reason };
		const runbook = made.runbook;
		// The owner approved a preview of one revision; a newer one is different words.
		if (op.expectedRevision !== undefined && op.expectedRevision !== runbook.revision) {
			return { fired: false, reason: `this runbook changed to revision ${runbook.revision}; preview it again` };
		}

		let team: string;
		let sessionId: string | undefined;
		if (op.into.kind === "new") {
			const opened = await intoNewSession(op.into, runbook, ctx);
			if ("fired" in opened) return opened;
			({ team, sessionId } = opened);
		} else {
			team = op.into.target;
		}

		const sent = await deliver(team, made.text, ctx);
		if (!sent.ok) {
			console.warn(`[runbook] "${runbook.name}" refused by ${team}: ${sent.error ?? "no reason given"}`);
			return { fired: false, sessionId, reason: sent.error ?? "the runbook could not be delivered" };
		}
		console.log(`[runbook] "${runbook.name}" fired into ${team}`);
		return { fired: true, sessionId: sessionId ?? team };
	}

	return { preview, fire };
}
