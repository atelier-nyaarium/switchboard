import type { CliRefusal } from "../../shared/cli-resolve.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { ownerLaunchLine } from "../../shared/launch-notice.js";
import { renderRunbook } from "../../shared/runbook-grammar.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";
import type { CliPick, SessionHarness } from "../../shared/session-harness.js";
import { composeSessionName } from "../../shared/session-id.js";
import type { ConsoleTargets } from "./consoleTargets.js";

export interface RunbookFireResult {
	fired: boolean;
	sessionId?: string;
	reason?: string;
	status?: "starting";
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
		internal?: { unpicked?: true },
	) => Promise<{ id: string; status?: "pending" }>;
	/** Queued under any launch; `starting` when one runs. */
	deliver: (
		to: string,
		body: string,
		ctx: RunbookFireContext,
	) => Promise<{ ok: boolean; error?: string; starting?: boolean }>;
	/** The CLI a new session runs, or why none. */
	pick: (spawn: string, pick: CliPick | undefined) => { harness?: SessionHarness } | { refusal: CliRefusal };
}

export function createRunbookFireHandler({ targets, getRunbook, createSession, deliver, pick }: RunbookFireDeps) {
	async function intoNewSession(
		into: Extract<ConsoleOp, { kind: "runbook_fire" }>["into"] & { kind: "new" },
		runbook: Pick<Runbook, "name">,
		ctx: RunbookFireContext,
	): Promise<{ team: string; sessionId: string } | RunbookFireResult> {
		const chosen = pick(targets.localSpawn(into.target), into.cli);
		if ("refusal" in chosen) {
			return { fired: false, reason: ownerLaunchLine({ failure: { kind: "cli", refusal: chosen.refusal } }) };
		}
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
		return { fired: true, sessionId: sessionId ?? team, ...(sent.starting ? { status: "starting" as const } : {}) };
	}

	return { preview, fire };
}
