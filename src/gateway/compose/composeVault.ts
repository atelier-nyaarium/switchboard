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
import { createAnswerEntry } from "../vault/answerEntry.js";
import { createVaultDecisions, qualificationRefusal } from "../vault/decisions.js";
import { createVaultReconcile } from "../vault/reconcile.js";
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
	/** Resolve after routine stage composition. */
	workingRoutine: (sessionTarget: string) => string | null;
	/** Record unanswered secrets for their occurrence. */
	secretUnanswered: (sessionTarget: string, entryId: string) => void;
	/** Resolve the policy store on each use. */
	policies: () => Pick<PolicyStore, "get" | "byKey" | "list" | "put">;
}

export interface VaultStage {
	routes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
	console: VaultConsoleHandlers;
	sessionEnded: (team: string) => void;
	entryDeleted: (entryId: string) => void;
	entriesListed: (entryIds: string[]) => void;
	/** Null policy means deletion. */
	policyMoved: (policyId: string) => void;
	policiesListed: (policies: AuthorizationPolicy[]) => void;
	/** Called only by routine saves. */
	setRoutineGrants: (routineId: string, entryIds: string[]) => void;
	/** Called only by owner ops. */
	setServiceGrants: (serviceId: string, entryIds: string[]) => void;
	/** The entries a service's standing grants name. */
	serviceGrants: (serviceId: string) => string[];
	readForService: (serviceId: string, entryId: string) => Promise<VaultRelease>;
	/** Read answerable now. */
	canRead: () => boolean;
	/** Whether this Gateway may use the entry, after a refresh. */
	usableHere: (entryId: string) => Promise<boolean>;
	/** Retracts stale cards when routable. */
	retractStale: () => void;
	/** The persist tick: tries kept takeovers again. */
	tick: () => void;
	/** Close: a pass in flight takes nothing over. */
	stop: () => void;
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
			validate: (scope) => {
				if (scope.policy === undefined) return null;
				return qualificationRefusal(deps.policies().get(scope.policy.policyId), {
					entryId: scope.entryId,
					policyRevision: scope.policy.policyRevision,
					displayShape: scope.displayShape,
				});
			},
			onApproved: (scope, decision) => {
				decisions.grant(decision, scope, ambient.now());
			},
		}),
	);

	const use = createVaultUse({
		client: () => context.slice()?.vaultClient ?? null,
		registered: () => context.slice()?.routerClient.isRegistered() ?? false,
		decisions,
		ambient,
		onRefreshed: () => reconciler.landed(),
	});

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

	const answerEntry: VaultConsoleHandlers["answerEntry"] = createAnswerEntry({
		use,
		requests,
		policies: deps.policies,
	});

	const reconciler = createVaultReconcile({
		requests,
		policies: deps.policies,
		use,
		heldClient: () => context.slice()?.vaultClient ?? null,
		covers: (scope) => decisions.covers(scope, ambient.now())?.tier ?? null,
	});

	return {
		routes,
		console: {
			answer: (requestId, decision, value, note) => requests.answer(requestId, decision, value, note),
			answerEntry,
			grants: () => ({ grants: decisions.list(ambient.now()) }),
			revoke: (grantId) => ({ revoked: decisions.revoke(grantId) }),
		},
		sessionEnded: (team) => {
			decisions.sessionEnded(team);
			requests.sessionEnded(team);
		},
		entryDeleted: (entryId) => decisions.entryDeleted(entryId),
		entriesListed: (entryIds) => decisions.entriesListed(entryIds),
		// Prune only after policy commit.
		policyMoved: (policyId) => {
			decisions.policyMoved(policyId, deps.policies().get(policyId));
			reconciler.reconcile();
		},
		tick: () => reconciler.reconcile(),
		stop: () => reconciler.stop(),
		policiesListed: (policies) => {
			const byId = new Map(policies.map((policy) => [policy.id, policy]));
			decisions.policiesListed((policyId) => byId.get(policyId) ?? null);
		},
		setRoutineGrants: (routineId, entryIds) => {
			decisions.setRoutineGrants(routineId, entryIds);
		},
		setServiceGrants: (serviceId, entryIds) => {
			decisions.setServiceGrants(serviceId, entryIds);
		},
		serviceGrants: (serviceId) =>
			decisions
				.standing()
				.filter((grant) => grant.holder.kind === "service" && grant.holder.serviceId === serviceId)
				.map((grant) => grant.entryId),
		readForService: (serviceId, entryId) => use.readForService(serviceId, entryId),
		canRead: () => use.canRead(),
		usableHere: async (entryId) => {
			const answer = await use.ready();
			return answer.kind === "ready" && use.usable(answer.client, entryId).kind === "usable";
		},
		retractStale: () => requests.retractStale(retract),
	};
}
