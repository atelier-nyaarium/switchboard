import type { DomainSnapshot } from "../../shared/admission.js";
import type { Ambient } from "../../shared/ambient.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type {
	CrossDomainConfirmResult,
	CrossDomainListenResult,
	CrossDomainListenStateResult,
	CrossDomainListPeersResult,
	CrossDomainRequestResult,
	CrossDomainUnlinkResult,
	DiscoverCoverage,
} from "../../shared/console-protocol.js";
import type { SignedXDomainLink } from "../../shared/federation-protocol.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { MAX_POLL_HOLD_MS } from "../../shared/schemas.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import type {
	AuthorizationPolicy,
	ConsolePolicyDeleteResult,
	ConsolePolicyListResult,
	ConsolePolicyPutResult,
} from "../../shared/schemasPolicy.js";
import type {
	ConsoleRoutineDeleteResult,
	ConsoleRoutineListResult,
	ConsoleRoutineNextResult,
	ConsoleRoutineOccurrenceResult,
	ConsoleRoutinePutResult,
	ConsoleRoutineRunResult,
	Routine,
} from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { VaultDecision, VaultGrant } from "../../shared/schemasVault.js";
import type { SessionStore } from "../../shared/session-store.js";
import type { GatewaySpawnPoints, TeamInfo } from "../../shared/types.js";
import type { DeliverToOwner } from "../consolePushOps.js";
import type { WakeResult } from "../wake.js";
import type { ConversationRegistry, TeamRegistry } from "../wsTypes.js";
import type { DurableOpStore } from "./durableOpStore.js";

export interface ConsoleRoutes {
	// Owner-only console door.
	sendFromOwner: (body: Record<string, unknown>) => Promise<Response>;
	// The key that send will anchor on, for an answer owed before it resolves.
	ownerSessionKey: (to: string, targetDomain?: string) => string;
	respond: (
		req: Request,
		body: Record<string, unknown>,
		opts?: { consoleSender?: boolean; onFederatedSettled?: (ok: boolean) => void },
	) => Response;
	teams: () => Response;
	discover: (url?: URL) => Promise<Response>;
	// Discovery spans every same-Domain Gateway.
	discoverFull: () => Promise<{
		teams: TeamInfo[];
		coverage: DiscoverCoverage;
		/** Absent means unadvertised, not empty. */
		spawnPoints?: GatewaySpawnPoints[];
	}>;
	// The sole mailbox writer converges delivery across same-Domain Gateways.
	deliverToOwner: DeliverToOwner;
}

export type TrustedCatalogProject = (name: string) => boolean;

export interface SendRouteJson {
	session_id?: string;
	status?: string;
	error?: string;
}

export interface ConsoleHandlerDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	routes: ConsoleRoutes;
	// Session ids use the composite Gateway and name key.
	localGatewayId: string;
	localDomainId: string;
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	sendBoundMs?: number;
	createSessionBoundMs?: number;
	// Catalog projects cannot be claimed by device sessions.
	isTrustedCatalogProject?: TrustedCatalogProject;
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "hostWorkdirHint"
		| "forget"
		| "rename"
		| "ensureBindToken"
	>;
	// Keyring snapshots send only when the version changes.
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	// Devcontainer creation wakes before host relay.
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	// Closing a team during wake must refuse.
	isWakeInFlight?: (team: string) => boolean;
	// Host creation remains verifying until MCP registration.
	joinCreate?: (
		team: string,
		start: () => Promise<HostOpResult>,
	) => { launch: Promise<HostOpResult>; release: (() => void) | null };
	awaitRegister?: (team: string) => Promise<WakeResult>;
	crossDomain?: CrossDomainConsoleHandlers;
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner?: (ownerSignPub: string) => CrossDomainUnlinkResult;
	durableOpStore?: DurableOpStore;
	vault?: VaultConsoleHandlers;
	runbooks?: RunbookConsoleHandlers;
	routines?: RoutineConsoleHandlers;
	policies?: PolicyConsoleHandlers;
	onSessionEnded?: (team: string) => void;
}

export interface PolicyConsoleHandlers {
	list: () => ConsolePolicyListResult;
	/** `base` absent on create. */
	put: (policy: AuthorizationPolicy, base?: number) => ConsolePolicyPutResult;
	remove: (policyId: string, base: number) => ConsolePolicyDeleteResult;
	enable: (policyId: string, enabled: boolean, base: number) => ConsolePolicyPutResult;
}

export interface RunbookConsoleHandlers {
	/** The fire reads one by id; every other reader takes the list. */
	get: (runbookId: string) => Runbook | null;
	list: () => { runbooks: Runbook[] };
	put: (
		runbook: Runbook,
		options?: { base?: number; overwrite?: boolean },
	) => { stored: boolean; revision: number; runbook?: Runbook; reason?: string };
	remove: (runbookId: string) => { deleted: boolean };
}

/** The runner behind these arrives in a later phase; the wire is settled first. */
export interface RoutineConsoleHandlers {
	list: () => ConsoleRoutineListResult;
	/** `base` is the revision the editor was opened at, absent on a first save. */
	put: (routine: Routine, base?: number) => ConsoleRoutinePutResult;
	/** What a candidate would next run at, so recurrence stays in one implementation. */
	nextAt: (routine: Routine) => ConsoleRoutineNextResult;
	remove: (routineId: string) => ConsoleRoutineDeleteResult;
	enable: (routineId: string, enabled: boolean, base?: number) => ConsoleRoutinePutResult;
	runNow: (routineId: string, occurrenceId: string) => Promise<ConsoleRoutineOccurrenceResult>;
	/** A fresh run at the gateway's `now`, which is why it answers the occurrence it opened. */
	run: (routineId: string) => Promise<ConsoleRoutineRunResult>;
	dismiss: (routineId: string, occurrenceId: string) => ConsoleRoutineOccurrenceResult;
}

export interface VaultConsoleHandlers {
	answer: (
		requestId: string,
		decision: VaultDecision,
		value?: ContentEnvelope,
		note?: string,
	) => { ok: boolean; reason?: string };
	grants: () => { grants: VaultGrant[] };
	revoke: (grantId: string) => { revoked: boolean };
}

export interface CrossDomainConsoleHandlers {
	listen: () => CrossDomainListenResult;
	request: (args: {
		listeningToken: string;
		pin: string;
		requesterOwnerSignPub: string;
		requesterDomainId: string;
	}) => Promise<CrossDomainRequestResult>;
	confirm: (args: { pin: string; mySignedLink: SignedXDomainLink }) => CrossDomainConfirmResult;
	cancel: (args: { listeningToken?: string; pin?: string }) => boolean;
	listenState: (listeningToken: string) => CrossDomainListenStateResult;
	listPeers: () => CrossDomainListPeersResult;
}

export function friendlyPeekError(error?: string, kind?: HostOpResult["errorKind"]): string {
	// Absent sessions are transient, but preserve the host cause.
	const raw = error ?? "peek failed";
	if (kind === "absent") return `No session running - it may be starting or has stopped: ${raw}`;
	return raw;
}

// Ambiguous host failures must not roll back a possibly running launch.
export class CreateSessionAmbiguousError extends Error {}

export const FAKE_REQ = new Request("http://gateway/console");

// The Android read timeout must exceed this bound.
export const SEND_BOUND_MS = 25_000;

// The Android retry window must exceed this bound.
export const CREATE_SESSION_BOUND_MS = 25_000;

export const HOLD_CAP_MS = MAX_POLL_HOLD_MS;
