import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { ConsolePushEntry } from "../../shared/federation-protocol.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import { ownerKeyId } from "../../shared/owner-id.js";
import type { AuthorizationPolicy } from "../../shared/schemasPolicy.js";
import type { VaultRequest, VaultRetract } from "../../shared/schemasVault.js";
import { type Address, storeKey } from "../../shared/session-id.js";
import type { VaultConsoleHandlers } from "../console/consoleTypes.js";
import type { PolicyStore } from "../policies/store.js";
import { createAddressing } from "../routes/addressing.js";
import { createVaultDecisions, qualificationRefusal } from "../vault/decisions.js";
import { createVaultRequests } from "../vault/requests.js";
import { createVaultRoutes } from "../vault/vaultRoutes.js";
import { createVaultUse, type VaultRelease } from "../vault/vaultUse.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { FederationContext } from "./federationContext.js";

export interface VaultStageDeps {
	dataDir: string;
	localGatewayId: string;
	ambient: Ambient;
	context: FederationContext;
	routes: () => Pick<GatewayRoutes, "deliverToOwner">;
	sessions: Pick<SessionsStage, "sessionAuthority" | "sessionStore">;
	/** Read late, since the routine stage is composed after this one. */
	workingRoutine: (sessionTarget: string) => string | null;
	/** A secret nobody answered for, recorded against whatever occurrence wanted it. */
	secretUnanswered: (sessionTarget: string, entryId: string) => void;
	/** Read late. */
	policies: () => Pick<PolicyStore, "get" | "byKey">;
}

export interface VaultStage {
	routes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	console: VaultConsoleHandlers;
	sessionEnded: (team: string) => void;
	entryDeleted: (entryId: string) => void;
	entriesListed: (entryIds: string[]) => void;
	/** Deleted is a move to nothing. */
	policyMoved: (policyId: string) => void;
	policiesListed: (policies: AuthorizationPolicy[]) => void;
	/** The one road to a routine's grants, reached from a routine save and from nowhere else. */
	setRoutineGrants: (routineId: string, entryIds: string[]) => void;
	/** The one road to a watcher's grants, reached from an owner op and from nowhere else. */
	setWatcherGrants: (watcherId: string, entryIds: string[]) => void;
	/** The entries a watcher's standing grants name. */
	watcherGrants: (watcherId: string) => string[];
	readForWatcher: (watcherId: string, entryId: string) => Promise<VaultRelease>;
	/** Whether this Gateway may use the entry's value, after a refresh. */
	usableHere: (entryId: string) => Promise<boolean>;
	/** Retracts stale cards when routable. */
	retractStale: () => void;
}

export function composeVault(deps: VaultStageDeps): VaultStage {
	const { ambient, context, localGatewayId, sessions } = deps;
	const decisions = openDurable(deps.dataDir, "vault-decisions", (store) =>
		createVaultDecisions({ store, ambient, routineHolding: (target) => deps.workingRoutine(target) }),
	);
	const ownerSignPub = () => context.slice()?.allowlist.ownerSignPub ?? null;
	const localAddress = (sessionTarget: string): Address =>
		createAddressing({ config: { localGatewayId, localDomainId: context.activeDomainId() } }).localAddress(
			sessionTarget,
		);

	const threadKey = (sessionTarget: string, owner: string): string =>
		storeKey({ kind: "conv", conversationId: ownerKeyId(owner), address: localAddress(sessionTarget) });

	const action = (
		request: Pick<VaultRequest, "sessionTarget">,
		actionType: "request" | "retract",
		payload: VaultRequest | VaultRetract,
	): ConsolePushEntry | null => {
		const owner = ownerSignPub();
		if (!owner) return null;
		try {
			return {
				kind: "plugin_action",
				session_id: threadKey(request.sessionTarget, owner),
				pluginId: "vault",
				actionType,
				payload,
			};
		} catch {
			return null;
		}
	};

	const deliver = (request: VaultRequest): boolean | typeof MIGRATING => {
		const entry = action(request, "request", request);
		if (!entry) return false;
		// Answer state is process-local.
		return deps
			.routes()
			.deliverToOwner({ entry, dedupeKey: `vault:${request.requestId}`, label: "vault", volatile: true });
	};

	/** Queued for every console. */
	const retract = (request: Pick<VaultRequest, "requestId" | "sessionTarget">): boolean => {
		const entry = action(request, "retract", { requestId: request.requestId });
		if (!entry) return false;
		return (
			deps.routes().deliverToOwner({ entry, dedupeKey: `vault-retract:${request.requestId}`, label: "vault" }) ===
			true
		);
	};

	const requests = openDurable(deps.dataDir, "vault-open-requests", (ledger) =>
		createVaultRequests({
			ambient,
			deliver,
			ledger,
			onSettled: (request) => retract(request),
			onUnanswered: (request) => {
				if (request.kind !== "entry") return;
				deps.secretUnanswered(request.sessionTarget, request.entryId);
			},
			openTyped: (envelope, requestId) => context.slice()?.vaultClient.openTyped(envelope, requestId) ?? null,
			// Recheck policy on answer.
			validate: (request) => {
				if (request.kind !== "entry" || request.policy === undefined) return null;
				return qualificationRefusal(deps.policies().get(request.policy.policyId), {
					entryId: request.entryId,
					policyRevision: request.policy.policyRevision,
					displayShape: request.displayShape,
				});
			},
			onApproved: (request, decision) => {
				if (request.kind !== "entry") return;
				decisions.grant(
					decision,
					{
						entryId: request.entryId,
						displayShape: request.displayShape,
						coveredShapes: request.coveredShapes,
						sessionTarget: request.sessionTarget,
						...(request.policy ? { policy: request.policy } : {}),
					},
					ambient.now(),
				);
			},
		}),
	);

	const use = createVaultUse({ client: () => context.slice()?.vaultClient ?? null, decisions, ambient });

	const routes = createVaultRoutes({
		use,
		decisions,
		requests,
		policies: deps.policies,
		ambient,
		resolveCaller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			return record ? sessions.sessionStore.teamOf(record) : null;
		},
		notifyOwner: (sessionTarget, title, body) => {
			let sender: Address;
			try {
				sender = localAddress(sessionTarget);
			} catch {
				return;
			}
			deps.routes().deliverToOwner({
				entry: {
					kind: "notice",
					session_id: storeKey({ kind: "notice", sender }),
					from: sender.canonical,
					title,
					summary: body,
					body,
				},
				dedupeKey: ambient.newId(),
				label: "vault",
			});
		},
	});

	return {
		routes,
		console: {
			answer: (requestId, decision, value, note) => requests.answer(requestId, decision, value, note),
			grants: () => ({ grants: decisions.list(ambient.now()) }),
			revoke: (grantId) => ({ revoked: decisions.revoke(grantId) }),
		},
		sessionEnded: (team) => {
			decisions.sessionEnded(team);
			requests.sessionEnded(team);
		},
		entryDeleted: (entryId) => decisions.entryDeleted(entryId),
		entriesListed: (entryIds) => decisions.entriesListed(entryIds),
		// Policy first, then prune: the store has committed before it says so.
		policyMoved: (policyId) => {
			decisions.policyMoved(policyId, deps.policies().get(policyId));
			requests.policyMoved(policyId);
		},
		policiesListed: (policies) => {
			const byId = new Map(policies.map((policy) => [policy.id, policy]));
			decisions.policiesListed((policyId) => byId.get(policyId) ?? null);
		},
		setRoutineGrants: (routineId, entryIds) => {
			decisions.setRoutineGrants(routineId, entryIds);
		},
		setWatcherGrants: (watcherId, entryIds) => {
			decisions.setWatcherGrants(watcherId, entryIds);
		},
		watcherGrants: (watcherId) =>
			decisions
				.list(ambient.now())
				.filter((grant) => grant.holder.kind === "watcher" && grant.holder.watcherId === watcherId)
				.map((grant) => grant.entryId),
		readForWatcher: (watcherId, entryId) => use.readForWatcher(watcherId, entryId),
		usableHere: async (entryId) => {
			const answer = await use.ready();
			return answer.kind === "ready" && use.usable(answer.client, entryId).kind === "usable";
		},
		retractStale: () => requests.retractStale(retract),
	};
}
