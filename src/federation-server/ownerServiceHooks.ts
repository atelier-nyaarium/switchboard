import type { GatewayFrameHandler, GatewayRegistration } from "./gatewayBridge.js";
import type { OwnerOpHandler, OwnerOpKind, OwnerOpMutation } from "./ownerOpRegistry.js";

export interface OwnerServiceHooks {
	ownerOp<Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>): void;
	/** The class the migration fence reads; `value` waits behind it. */
	gatewayFrame(name: string, mutation: OwnerOpMutation, handler: GatewayFrameHandler): void;
	onGatewayRegistered(listener: (reg: GatewayRegistration) => void): void;
	onGatewayDropped(listener: (reg: GatewayRegistration) => void): void;
	/** `false` says the listener's write did not land, so the Gateway reports the forget again. */
	onSessionForgotten(listener: SessionForgottenListener): void;
	/** Sweep hooks run per Domain under migration fencing. */
	onSweep(label: string, sweep: (domainId: string, now: number) => void): void;
	/** False when the gateway is disconnected; frames include its incarnation. */
	pushFrameTo(domainId: string, gatewayId: string, frame: Record<string, unknown>): boolean;
	gatewayIncarnation(domainId: string, gatewayId: string): number | null;
	connectedGateways(domainId: string): string[];
}

export type SessionForgottenListener = (reg: GatewayRegistration, sessionId: string) => boolean | undefined;

export type { GatewayFrameHandler, GatewayRegistration, OwnerOpHandler };
