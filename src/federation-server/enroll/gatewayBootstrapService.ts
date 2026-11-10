import { type DomainSnapshot, resolveAdmitted } from "../../shared/admission.js";
import type { Clock } from "../../shared/ambient.js";
import { sealSignedBy } from "../../shared/crypto.js";
import { bootstrapAskVerifies } from "../../shared/gateway-bootstrap.js";
import type {
	GatewayBootstrapAsk,
	GatewayBootstrapAskResult,
	GatewayBootstrapFrame,
	GatewayBootstrapPutResult,
	GatewayBootstrapRefusal,
} from "../../shared/schemasGatewayBootstrap.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

////////////////////////////////
//  Constants

// The phone hands in again while its setup is pending.
const HOLD_MS = 1_800_000;
const MAX_FRAME_BYTES = 262_144;
export const MAX_BOOTSTRAPS_PER_DOMAIN = 8;
const MAX_HELD = 256;

////////////////////////////////
//  Interfaces & Types

interface Held {
	domainId: string;
	gatewaySignPub: string;
	frame: GatewayBootstrapFrame;
	at: number;
}

type Deps = {
	ambient: Clock;
	getDomain: (domainId: string) => DomainSnapshot | null;
};

////////////////////////////////
//  Functions & Helpers

function signedBySender(frame: GatewayBootstrapFrame): boolean {
	try {
		return sealSignedBy(frame.sealed, frame.signerSignPub);
	} catch {
		return false;
	}
}

/** Frames a phone left for a Gateway to collect. In memory only; a restart drops them. */
export function createGatewayBootstrapService(deps: Deps) {
	const held = new Map<string, Held>();

	const sweep = (): void => {
		const cutoff = deps.ambient.now() - HOLD_MS;
		for (const [pickupId, entry] of held) {
			if (entry.at <= cutoff) held.delete(pickupId);
		}
	};

	const admitsGateway = (domainId: string, gatewaySignPub: string): boolean => {
		const snapshot = deps.getDomain(domainId);
		if (!snapshot) return false;
		const { admissions, revocations, ownerSignPub } = snapshot;
		return resolveAdmitted(admissions, revocations, ownerSignPub, gatewaySignPub)?.kind === "gateway";
	};

	const refusalOf = (
		domainId: string,
		signer: string,
		pickupId: string,
		gatewaySignPub: string,
		frame: GatewayBootstrapFrame,
	): GatewayBootstrapRefusal | null => {
		if (frame.signerSignPub !== signer || !signedBySender(frame)) return "bad_frame";
		if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_FRAME_BYTES) return "too_large";
		if (!admitsGateway(domainId, gatewaySignPub)) return "not_admitted";
		const existing = held.get(pickupId);
		if (existing) return existing.domainId === domainId ? null : "taken";
		const ofDomain = [...held.values()].filter((entry) => entry.domainId === domainId).length;
		return ofDomain >= MAX_BOOTSTRAPS_PER_DOMAIN || held.size >= MAX_HELD ? "too_many" : null;
	};

	const put = (
		domainId: string,
		signer: string,
		pickupId: string,
		gatewaySignPub: string,
		frame: GatewayBootstrapFrame,
	): GatewayBootstrapPutResult => {
		sweep();
		const refusal = refusalOf(domainId, signer, pickupId, gatewaySignPub, frame);
		if (refusal) return { held: false, refusal };
		held.set(pickupId, { domainId, gatewaySignPub, frame, at: deps.ambient.now() });
		return { held: true };
	};

	const status = (domainId: string, pickupId: string): { held: boolean } => {
		sweep();
		return { held: held.get(pickupId)?.domainId === domainId };
	};

	/** The public read. An unknown id, another key and a bad signature answer alike. */
	const ask = (asked: GatewayBootstrapAsk): GatewayBootstrapAskResult => {
		sweep();
		const entry = held.get(asked.pickupId);
		if (!entry || entry.gatewaySignPub !== asked.gatewaySignPub || !bootstrapAskVerifies(asked)) return {};
		// Revoked since the hand-in.
		if (!admitsGateway(entry.domainId, entry.gatewaySignPub)) {
			held.delete(asked.pickupId);
			return {};
		}
		return { frame: entry.frame };
	};

	const releaseFor = (domainId: string, gatewaySignPub: string): void => {
		for (const [pickupId, entry] of held) {
			if (entry.domainId === domainId && entry.gatewaySignPub === gatewaySignPub) held.delete(pickupId);
		}
	};

	const register = (hooks: OwnerServiceHooks): void => {
		hooks.ownerOp("gateway_bootstrap_put", (op, value) =>
			put(op.domainId, op.signerSignPub, value.pickupId, value.gatewaySignPub, value.frame),
		);
		hooks.ownerOp("gateway_bootstrap_status", (op, value) => status(op.domainId, value.pickupId));
		hooks.onGatewayRegistered((reg) => releaseFor(reg.domainId, reg.signPub));
	};

	return { put, status, ask, register };
}
