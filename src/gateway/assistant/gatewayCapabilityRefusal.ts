import type { UnavailableReason } from "../../shared/schemasPhoneCapabilities.js";

export class GatewayCapabilityRefusal extends Error {
	constructor(
		readonly reason: UnavailableReason,
		readonly detail?: string,
	) {
		super("Gateway capability unavailable");
		this.name = "GatewayCapabilityRefusal";
	}
}

export class GatewayCapabilityRejected extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "GatewayCapabilityRejected";
	}
}
