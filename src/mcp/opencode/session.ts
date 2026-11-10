// One OpenCode session as the plugin drives it.

import { type OpencodeServerFile, promptIdOf } from "../../shared/opencode.js";
import type { DerivedPresence } from "../../shared/schemasPresence.js";
import type { SessionControlOp, SessionControlResult } from "../../shared/session-control.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";
import { createOpencodeClient, OpencodeHttpError } from "./client.js";
import { createOpencodeFollower } from "./follower.js";

////////////////////////////////
//  Interfaces & Types

export interface OpencodeSessionDeps {
	file: OpencodeServerFile;
	fetch: typeof fetch;
	/** The tag a pushed row is typed as. */
	render(payload: ChannelPushPayload | ResponsePushPayload): Promise<string>;
	report(derived: DerivedPresence | undefined): void;
	newId(): string;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

/** A session the plugin drives over its CLI's own server. */
export interface ApiSession {
	start(): void;
	stop(): void;
	/** What was last reported. */
	current(): DerivedPresence | undefined;
	deliver(push: ChannelPushPayload): Promise<void>;
	respond(push: ResponsePushPayload): Promise<void>;
	control(op: SessionControlOp): Promise<SessionControlResult>;
}

////////////////////////////////
//  Constants

const DELIVER_TRIES = 5;
const DELIVER_RETRY_MS = 1000;
const NOTICE_LABEL = "Switchboard notice";

////////////////////////////////
//  Functions & Helpers

/** A refusal is final; a server that did not answer may yet. */
const retries = (error: unknown): boolean => !(error instanceof OpencodeHttpError) || error.status >= 500;

export function createOpencodeSession(deps: OpencodeSessionDeps): ApiSession {
	const client = createOpencodeClient(deps.file, deps.fetch);
	const follower = createOpencodeFollower({
		client,
		report: deps.report,
		sleep: deps.sleep,
		log: (line) => deps.log(`[opencode] ${line}`),
	});

	async function post(send: () => Promise<void>): Promise<void> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				await send();
				return;
			} catch (error) {
				if (!retries(error) || attempt >= DELIVER_TRIES) throw error;
				await deps.sleep(DELIVER_RETRY_MS * attempt);
			}
		}
	}

	return {
		start: () => follower.start(),
		stop: () => follower.stop(),
		current: () => follower.current(),
		deliver: async (push) => {
			const text = await deps.render(push);
			// One id per delivery, so a retry lands once.
			const id = promptIdOf(push.delivery_id ?? deps.newId());
			// A notice that asks nothing adds context without a turn.
			const quiet = push.no_ack === true && push.act === "no_act";
			await post(() => (quiet ? client.synthetic(id, text, NOTICE_LABEL) : client.prompt(id, text)));
		},
		respond: async (push) => {
			const text = await deps.render(push);
			const id = promptIdOf(deps.newId());
			await post(() => client.prompt(id, text));
		},
		control: async (op) => {
			const permission = follower.permission(op.promptId);
			if (!permission) return { ok: true, outcome: "stale" };
			const outcome = await client.replyPermission(
				permission,
				op.decision === "approve" ? "once" : "reject",
				op.decision === "deny" ? op.reason : undefined,
			);
			return { ok: true, outcome };
		},
	};
}
