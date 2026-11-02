import type { UnavailableReason } from "../../shared/schemasPhoneCapabilities.js";

export class GatewayCapabilityRefusal extends Error {
	constructor(readonly reason: UnavailableReason) {
		super("Gateway capability unavailable");
		this.name = "GatewayCapabilityRefusal";
	}
}
