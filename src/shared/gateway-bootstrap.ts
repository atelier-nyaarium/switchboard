import crypto from "node:crypto";
import { sign, verify } from "./crypto.js";
import type { GatewayBootstrapAsk } from "./schemasGatewayBootstrap.js";
import { SIGNING_TAGS } from "./wire-vocabulary.js";

////////////////////////////////
//  Functions & Helpers

/** What the phone and the Gateway both name a held frame by. */
export function bootstrapPickupId(code: string): string {
	return crypto.createHash("sha256").update(`${SIGNING_TAGS.gatewayBootstrapPickup}\n${code}`, "utf8").digest("hex");
}

function askSigningBytes(pickupId: string, gatewaySignPub: string): Buffer {
	return Buffer.from([SIGNING_TAGS.gatewayBootstrapAsk, pickupId, gatewaySignPub].join("\n"), "utf8");
}

// No timestamp: a replay yields only a sealed frame.
export function signBootstrapAsk(pickupId: string, gatewaySignPub: string, signPrivB64: string): GatewayBootstrapAsk {
	return { pickupId, gatewaySignPub, signature: sign(askSigningBytes(pickupId, gatewaySignPub), signPrivB64) };
}

export function bootstrapAskVerifies(ask: GatewayBootstrapAsk): boolean {
	return verify(askSigningBytes(ask.pickupId, ask.gatewaySignPub), ask.signature, ask.gatewaySignPub);
}
