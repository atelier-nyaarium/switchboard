// A setup that has not finished: its record, its asks to the Router, and the bootstrap install.

import type { Ambient } from "../../shared/ambient.js";
import type { Identity } from "../../shared/crypto.js";
import { bootstrapPickupId, signBootstrapAsk } from "../../shared/gateway-bootstrap.js";
import type { EnrollArmAnswer, EnrollGatewayPayload, EnrollStatus } from "../../shared/schemasEnrollSetup.js";
import { GatewayBootstrapAskResultSchema, type GatewayBootstrapFrame } from "../../shared/schemasGatewayBootstrap.js";
import { ROUTER_PATHS } from "../../shared/wire-vocabulary.js";
import type { GatewayBoot } from "../boot.js";
import { activateStaged, openBootstrapBundle, stageBootstrap } from "../federation/bootstrapInstall.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";
import {
	type EnrollPending,
	readEnrollPending,
	retireEnrollPending,
	writeEnrollPending,
} from "../federation/enrollPending.js";
import type { RouterAnswer, RouterExchanger } from "../router/routerExchange.js";
import { loadRouterTransport } from "../router/transport.js";
import type { FederationContext } from "./federationContext.js";

const ASK_EVERY_MS = 3_000;
const EXCHANGE_DEADLINE_MS = 8_000;
const CODE_BYTES = 16;

export interface EnrollmentStageDeps {
	federationDir: string;
	localGatewayId: string;
	ambient: Pick<Ambient, "now" | "randomBytes">;
	identity: () => Identity;
	contentKeyStore: ContentKeyStore;
	/** Re-reads the federation directory after an install. */
	resolveBoot: () => GatewayBoot;
	context: FederationContext;
	exchange: RouterExchanger;
	/** The Router address this Gateway was armed with, for its first dial. */
	onInstalled: (routerUrl: string) => void;
	isClosing: () => boolean;
}

export interface EnrollmentStage {
	/** Picks a record up after a restart. Nothing asks until a status read does. */
	resume: () => void;
	arm: (routerUrl: string) => Promise<EnrollArmAnswer>;
	/** The latest state, and the trigger for the next ask. */
	status: () => EnrollStatus;
	stop: () => void;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether the peer answered as a Router, naming the certificate it presented. */
function answersAsRouter(seen: RouterAnswer): boolean {
	if (seen.status !== 200) return false;
	try {
		const health = JSON.parse(seen.body) as { ok?: unknown; certFingerprint?: unknown };
		return health.ok === true && health.certFingerprint === seen.certFp;
	} catch {
		return false;
	}
}

export function composeEnrollment(deps: EnrollmentStageDeps): EnrollmentStage {
	const { context, federationDir, localGatewayId, contentKeyStore, ambient } = deps;
	let pending: EnrollPending | null = null;
	let outcome: EnrollStatus = { state: "none" };
	let installedDomain: string | null = null;
	let lastAskAt = Number.NEGATIVE_INFINITY;
	let inFlight: AbortController | null = null;
	/** A frame already refused, so the same one is not opened on every ask. */
	let refusedFrame: string | null = null;

	const payloadOf = (record: EnrollPending): EnrollGatewayPayload => {
		const identity = deps.identity();
		return {
			type: "enroll-gateway",
			gatewayId: localGatewayId,
			signPub: identity.sign.pub,
			boxPub: identity.box.pub,
			code: record.code,
		};
	};

	function install(frame: GatewayBootstrapFrame, record: EnrollPending): void {
		const identity = deps.identity();
		const bundle = openBootstrapBundle(frame, identity, record.code, localGatewayId);
		if ((bundle.transport.routerCertFp ?? "").trim().toLowerCase() !== record.routerCertFp) {
			throw new Error("the bundle names another Router certificate");
		}
		// A transport with no Domain never activates.
		if (!bundle.domainId) throw new Error("the bundle names no Domain");
		const heldKeyCount = contentKeyStore.epochs().length;
		stageBootstrap(federationDir, bundle, identity, contentKeyStore, ambient, frame.signerSignPub);
		try {
			activateStaged(federationDir, ambient);
		} catch (error) {
			console.error(`[enroll] bundle staged; a gateway restart completes it: ${reasonOf(error)}`);
			throw new Error("bundle is staged; a gateway restart completes it");
		}
		contentKeyStore.reload();
		console.log(`[federation] content keys: held ${heldKeyCount}, delivered ${bundle.contentKeys?.length ?? 0}`);
		retireEnrollPending(federationDir);
		pending = null;
		installedDomain = bundle.domain.displayName ?? null;
		deps.onInstalled(record.routerUrl);
		context.standalone();
		const installedBoot = deps.resolveBoot();
		if (installedBoot.kind !== "active") {
			console.log("[enroll] credentials installed but no Domain id resolved; re-run setup.sh (Gateway Setup).");
			return;
		}
		try {
			context.activate(installedBoot.boot);
			console.log(`[enroll] installed credentials for Gateway "${localGatewayId}"; connecting to the Router.`);
		} catch (error) {
			console.error(`[enroll] credentials installed but Router activation failed: ${reasonOf(error)}`);
		}
	}

	async function askOnce(record: EnrollPending, signal: AbortSignal): Promise<void> {
		const identity = deps.identity();
		let answer: RouterAnswer;
		try {
			answer = await deps.exchange({
				url: record.routerUrl,
				method: "POST",
				path: ROUTER_PATHS.gatewayBootstrap,
				body: signBootstrapAsk(bootstrapPickupId(record.code), identity.sign.pub, identity.sign.priv),
				pin: record.routerCertFp,
				deadlineMs: EXCHANGE_DEADLINE_MS,
				signal,
			});
		} catch (error) {
			if (pending === record && !signal.aborted) {
				outcome = { state: "unreachable", router: record.routerUrl, reason: reasonOf(error) };
			}
			return;
		}
		// Armed again, installed or closing while it was out.
		if (pending !== record || deps.isClosing()) return;
		// Busy is not gone.
		if (answer.status === 429) return;
		if (answer.status !== 200) {
			outcome = {
				state: "unreachable",
				router: record.routerUrl,
				reason: `the Router answered ${answer.status}`,
			};
			return;
		}
		let frame: GatewayBootstrapFrame | undefined;
		try {
			frame = GatewayBootstrapAskResultSchema.parse(JSON.parse(answer.body)).frame;
		} catch {
			outcome = { state: "unreachable", router: record.routerUrl, reason: "the Router's answer was unreadable" };
			return;
		}
		if (!frame) {
			if (outcome.state !== "refused") outcome = { state: "waiting" };
			return;
		}
		if (frame.sealed.signature === refusedFrame) return;
		try {
			install(frame, record);
		} catch (error) {
			refusedFrame = frame.sealed.signature;
			outcome = { state: "refused", reason: reasonOf(error) };
			console.error(`[enroll] bundle refused: ${reasonOf(error)}`);
		}
	}

	function resume(): void {
		pending = readEnrollPending(federationDir);
		if (pending) outcome = { state: "waiting" };
	}

	async function arm(routerUrl: string): Promise<EnrollArmAnswer> {
		if (deps.isClosing()) return { ok: false, error: "closing" };
		if (loadRouterTransport(federationDir)) return { ok: false, error: "already_enrolled" };
		let seen: RouterAnswer;
		try {
			seen = await deps.exchange({
				url: routerUrl,
				method: "GET",
				path: ROUTER_PATHS.health,
				deadlineMs: EXCHANGE_DEADLINE_MS,
			});
		} catch (error) {
			return { ok: false, error: "router_unreachable", router: routerUrl, reason: reasonOf(error) };
		}
		if (!answersAsRouter(seen)) {
			return { ok: false, error: "router_unreachable", router: routerUrl, reason: "no Router answered there" };
		}
		if (deps.isClosing()) return { ok: false, error: "closing" };
		const record: EnrollPending = {
			// A resume keeps its code.
			code: pending?.code ?? ambient.randomBytes(CODE_BYTES).toString("hex"),
			routerUrl,
			routerCertFp: seen.certFp,
		};
		writeEnrollPending(federationDir, record);
		pending = record;
		outcome = { state: "waiting" };
		refusedFrame = null;
		return { ok: true, payload: payloadOf(record), router: routerUrl };
	}

	function status(): EnrollStatus {
		const record = pending;
		if (!record) {
			return loadRouterTransport(federationDir)
				? { state: "installed", domain: installedDomain }
				: { state: "none" };
		}
		const now = ambient.now();
		if (!inFlight && !deps.isClosing() && now - lastAskAt >= ASK_EVERY_MS) {
			lastAskAt = now;
			const controller = new AbortController();
			inFlight = controller;
			void askOnce(record, controller.signal).finally(() => {
				if (inFlight === controller) inFlight = null;
			});
		}
		return outcome;
	}

	return {
		resume,
		arm,
		status,
		stop: () => inFlight?.abort(),
	};
}
