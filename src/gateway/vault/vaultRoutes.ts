// Vault values leave only in approved answers.

import { type Ambient, withinMs } from "../../shared/ambient.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import {
	VAULT_ROUTE_WAIT_CAP_MS,
	type VaultApprovedDecision,
	VaultAskpassRequestSchema,
	VaultCaptureRequestSchema,
	VaultCollectRequestSchema,
	type VaultPublicEntry,
	type VaultRequest,
	VaultSearchRequestSchema,
	VaultUseRequestSchema,
	type VaultValueAnswer,
	VaultWithdrawRequestSchema,
} from "../../shared/schemasVault.js";
import { jsonResponse as json } from "../agentRouteEnvelope.js";
import type { PolicyStore } from "../policies/store.js";
import type { VaultEntryView } from "../router/vaultClient.js";
import { presentedByRequest } from "../sessionAuthority.js";
import { displayShape, type GrantScope, type VaultDecisions } from "./decisions.js";
import { operationSet } from "./operationSet.js";
import type { VaultRequestAnswer, VaultRequests } from "./requests.js";
import type { VaultRelease, VaultUnready, VaultUnusable, VaultUse } from "./vaultUse.js";

const DEFAULT_WAIT_MS = 25_000;
const REFUSAL = "the owner did not authorize";

export interface VaultRoutesDeps {
	use: VaultUse;
	decisions: Pick<VaultDecisions, "covers">;
	requests: VaultRequests;
	/** Read late. */
	policies: () => Pick<PolicyStore, "byKey">;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Resolve requests to session teams. */
	resolveCaller: (req: Request) => string | null;
	/** A notice in the session's thread. */
	notifyOwner: (sessionTarget: string, title: string, body: string) => void;
}

type Handler = (req: Request, body: unknown) => Promise<Response>;

type Principal = { target: string };

const refused = (reason: string, status = 403, note?: string): Response =>
	json({ outcome: "refused", reason, ...(note ? { note } : {}) } satisfies VaultValueAnswer, status);

/** Migration, an unreachable owner, and too many open requests each read differently. */
const unopened = (reason: "migrating" | "unreachable" | "flooded"): Response => {
	if (reason === "flooded")
		return json({ outcome: "refused", reason: "too many vault requests are already open for this caller" }, 429);
	return json(
		{ outcome: "refused", reason: reason === "migrating" ? MIGRATING : "the owner cannot be reached" },
		503,
	);
};

const unready = (answer: VaultUnready): Response => json({ error: `vault unavailable: ${answer.reason}` }, 503);

const unusable = (answer: VaultUnusable): Response => refused(answer.reason, answer.status);

const publicView = (entry: VaultEntryView): VaultPublicEntry => ({
	id: entry.id,
	publicTitle: entry.publicTitle ?? "",
	...(entry.publicDescription === null ? {} : { publicDescription: entry.publicDescription }),
	hasValue: entry.hasValue,
});

export function createVaultRoutes(deps: VaultRoutesDeps): Map<string, Handler> {
	const waitFor = (requested: number | undefined) => Math.min(requested ?? DEFAULT_WAIT_MS, VAULT_ROUTE_WAIT_CAP_MS);

	/** An unknown token: not found. */
	const principal = (req: Request): Principal | Response => {
		const team = deps.resolveCaller(req);
		if (team) return { target: team };
		return presentedByRequest(req).token
			? json({ error: "not found" }, 404)
			: json({ error: "this session is not bound to the gateway" }, 401);
	};

	/** The wait ends at the answer, the budget, or the caller leaving; a leaver takes no answer. */
	async function waitAnswer(
		answer: Promise<VaultRequestAnswer>,
		waitMs: number,
		signal: AbortSignal,
	): Promise<VaultRequestAnswer | null | "gone"> {
		if (signal.aborted) return "gone";
		let onAbort: () => void = () => undefined;
		const gone = new Promise<"gone">((resolve) => {
			onAbort = () => resolve("gone");
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([withinMs(deps.ambient, answer, waitMs), gone]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Grants answer immediately; otherwise requests wait. A retry joins the request still open. */
	async function decide(
		req: Request,
		scope: GrantScope,
		operation: string,
		waitMs: number,
		asker?: string,
	): Promise<Response> {
		const covering = deps.decisions.covers(scope, deps.ambient.now());
		if (covering) {
			// The grant is read again after the refresh, as a watcher's is.
			const stillCovered = (): VaultUnusable | null =>
				deps.decisions.covers(scope, deps.ambient.now())
					? null
					: { kind: "unusable", reason: REFUSAL, status: 403 };
			return (await release(covering.tier, scope.entryId, stillCovered)).response;
		}
		const input = {
			kind: "entry" as const,
			entryId: scope.entryId,
			operation,
			sessionTarget: scope.sessionTarget,
			asker,
			policy: scope.policy,
		};
		const existing = deps.requests.find(input);
		const opened = existing ? { kind: "opened" as const, ...existing } : deps.requests.open(input);
		if (opened.kind !== "opened") return unopened(opened.reason);
		return settle(await waitAnswer(opened.answer, waitMs, req.signal), opened.request);
	}

	/** Unavailable keeps an approval for a retry; refused and released settle it. */
	type Release = { kind: "released" | "refused" | "unavailable"; response: Response };

	async function release(
		decision: VaultApprovedDecision,
		entryId: string,
		granted?: () => VaultUnusable | null,
	): Promise<Release> {
		const answer: VaultRelease = await deps.use.release(entryId, granted);
		if (answer.kind === "unready") return { kind: "unavailable", response: unready(answer) };
		if (answer.kind === "unusable") return { kind: "refused", response: unusable(answer) };
		if (answer.kind === "unopened") {
			return {
				kind: "unavailable",
				response: json({ outcome: "refused", reason: "the value could not be opened" }, 503),
			};
		}
		return {
			kind: "released",
			response: json({ outcome: "approved", decision, value: answer.value } satisfies VaultValueAnswer),
		};
	}

	/**
	 * An entry approval is shared: it named this caller's own operation, so every waiter joined to
	 * the request takes the value. A typed value is delivered once, to whoever collects first.
	 */
	async function settle(answer: VaultRequestAnswer | null | "gone", request: VaultRequest): Promise<Response> {
		if (answer === null || answer === "gone")
			return json({
				outcome: "pending",
				requestId: request.requestId,
				deadlineAt: request.deadlineAt,
			} satisfies VaultValueAnswer);
		if (answer.kind === "refused") {
			deps.requests.forget(request.requestId);
			return refused(REFUSAL, 403, answer.note);
		}
		if (request.kind === "typed") {
			const taken = deps.requests.forget(request.requestId);
			return taken && answer.typedValue !== undefined
				? json({
						outcome: "approved",
						decision: answer.decision,
						value: answer.typedValue,
					} satisfies VaultValueAnswer)
				: refused(REFUSAL);
		}
		const released = await release(answer.decision, request.entryId);
		if (released.kind !== "unavailable") deps.requests.forget(request.requestId);
		return released.response;
	}

	const search: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultSearchRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault search" }, 400);
		const ready = await deps.use.ready();
		if (ready.kind !== "ready") return unready(ready);
		const { client } = ready;
		const query = parsed.data.query?.trim().toLowerCase();
		const entries = client
			.live()
			.map((stored) => client.view(stored))
			.filter((entry) => entry.publicTitle !== null && client.allowedHere(entry))
			.filter(
				(entry) =>
					!query ||
					entry.publicTitle?.toLowerCase().includes(query) ||
					entry.publicDescription?.toLowerCase().includes(query),
			)
			.map(publicView);
		return json({ entries });
	};

	const use: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultUseRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault use request" }, 400);
		const ready = await deps.use.ready();
		if (ready.kind !== "ready") return unready(ready);
		const found = deps.use.usable(ready.client, parsed.data.entryId);
		if (found.kind !== "usable") return unusable(found);
		const scope = {
			entryId: parsed.data.entryId,
			displayShape: displayShape(parsed.data.operation),
			coveredShapes: operationSet(parsed.data.operation),
			sessionTarget: who.target,
		};
		return decide(req, scope, parsed.data.operation, waitFor(parsed.data.waitMs));
	};

	const collect: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultCollectRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault collect request" }, 400);
		const pending = deps.requests.collect(parsed.data.requestId, who.target);
		if (!pending) return refused(REFUSAL);
		return settle(await waitAnswer(pending.answer, waitFor(parsed.data.waitMs), req.signal), pending.request);
	};

	const withdraw: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultWithdrawRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault withdraw request" }, 400);
		return json({ withdrawn: deps.requests.withdraw(parsed.data.requestId, who.target) });
	};

	const capture: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultCaptureRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid vault capture" }, 400);
		const ready = await deps.use.ready();
		if (ready.kind !== "ready") return unready(ready);
		const { client } = ready;
		const id = deps.ambient.newId();
		// Trim the shell's trailing newline.
		const value = parsed.data.value.endsWith("\n") ? parsed.data.value.slice(0, -1) : parsed.data.value;
		if (!value) return json({ error: "invalid vault capture" }, 400);
		const created = await client.create({ id, ...parsed.data, value });
		if (created.kind === "unavailable") return json({ error: created.error }, 503);
		if (created.kind === "refused") return json({ error: created.refusal }, 409);
		deps.notifyOwner(
			who.target,
			"Vault entry captured",
			`${who.target} captured "${parsed.data.publicTitle}" as ${id}.`,
		);
		return json({ id });
	};

	/** The one enabled policy for the line's key selects its entry; otherwise the owner types. */
	const askpass: Handler = async (req, body) => {
		const who = principal(req);
		if (who instanceof Response) return who;
		const parsed = VaultAskpassRequestSchema.safeParse(body);
		if (!parsed.success) return json({ error: "invalid askpass request" }, 400);
		const ready = await deps.use.ready();
		if (ready.kind !== "ready") return unready(ready);
		const shape = displayShape(parsed.data.cmdline);
		const sessionTarget = who.target;
		const { asker } = parsed.data;
		const waitMs = waitFor(parsed.data.waitMs);
		// A binding this Gateway cannot use resolves nothing; a title never selects.
		const policy = deps.policies().byKey(shape);
		const bound = policy ? deps.use.usable(ready.client, policy.binding.entryId) : null;
		if (policy && bound?.kind === "usable") {
			const scope: GrantScope = {
				entryId: policy.binding.entryId,
				displayShape: shape,
				coveredShapes: operationSet(parsed.data.cmdline),
				sessionTarget,
				policy: { policyId: policy.id, policyRevision: policy.revision },
			};
			return decide(req, scope, parsed.data.cmdline, waitMs, asker);
		}
		const opened = deps.requests.open({ kind: "typed", operation: parsed.data.cmdline, sessionTarget, asker });
		if (opened.kind !== "opened") return unopened(opened.reason);
		return settle(await waitAnswer(opened.answer, waitMs, req.signal), opened.request);
	};

	return new Map<string, Handler>([
		["/vault/search", search],
		["/vault/use", use],
		["/vault/collect", collect],
		["/vault/withdraw", withdraw],
		["/vault/capture", capture],
		["/vault/askpass", askpass],
	]);
}
