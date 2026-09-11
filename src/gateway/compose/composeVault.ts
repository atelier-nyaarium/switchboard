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
		request: VaultRequest,
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
		// The answer lives in this process, so a row a restart never delivered would only mislead.
		return deps
			.routes()
			.deliverToOwner({ entry, dedupeKey: `vault:${request.requestId}`, label: "vault", volatile: true });
	};

	/** Every console drops the row, whichever road settled it. */
	const retract = (request: VaultRequest): void => {
		const entry = action(request, "retract", { requestId: request.requestId });
		if (entry)
			deps.routes().deliverToOwner({ entry, dedupeKey: `vault-retract:${request.requestId}`, label: "vault" });
	};

	const requests = createVaultRequests({
		ambient,
		deliver,
		onSettled: retract,
		onUnanswered: (request) => {
			if (request.kind !== "entry") return;
			deps.secretUnanswered(request.sessionTarget, request.entryId);
		},
		openTyped: (envelope, requestId) => context.slice()?.vaultClient.openTyped(envelope, requestId) ?? null,
		// The policy is read again at the tap, not trusted from when the request opened.
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
	});

	const routes = createVaultRoutes({
		client: () => context.slice()?.vaultClient ?? null,
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
	};
}
