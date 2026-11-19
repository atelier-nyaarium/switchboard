import { type Ambient, type Linked, linkedSignal } from "../../shared/ambient.js";
import { IFTTT_INTEGRATION_ID } from "../../shared/schemasIntegrations.js";
import type { IftttTriggerAnswer, IftttTriggerRequest } from "../../shared/schemasPhoneCapabilities.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import { GatewayCapabilityRefusal } from "./gatewayCapabilityRefusal.js";
import { ASSISTANT_WAITS } from "./waits.js";

const INTEGRATION_ID = IFTTT_INTEGRATION_ID;
const TIMEOUT = "ifttt request timed out";

interface IftttClientDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	vault: {
		entryId: () => string | undefined;
		readForService: (serviceId: string, entryId: string) => Promise<VaultRelease>;
	};
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
}

function bounded<T>(promise: Promise<T>, signal: Linked): Promise<T> {
	return Promise.race([
		promise,
		signal.ended.then(() => {
			throw new GatewayCapabilityRefusal("timeout");
		}),
	]);
}

export function createIftttClient(deps: IftttClientDeps) {
	return {
		/** `bound`: the whole call, the vault read counted. */
		async trigger(
			params: IftttTriggerRequest,
			bound: number = ASSISTANT_WAITS.action,
		): Promise<IftttTriggerAnswer> {
			const action = linkedSignal(deps.ambient, { ms: bound, reason: TIMEOUT });
			try {
				const entryId = deps.vault.entryId();
				if (entryId === undefined) throw new GatewayCapabilityRefusal("not_granted");
				let grant: VaultRelease;
				try {
					grant = await bounded(deps.vault.readForService(INTEGRATION_ID, entryId), action);
				} catch {
					// Nothing was sent.
					throw new GatewayCapabilityRefusal("not_ready");
				}
				if (grant.kind === "unusable") throw new GatewayCapabilityRefusal("not_granted");
				// Bound spent; nothing sent.
				if (grant.kind !== "released" || action.signal.aborted) throw new GatewayCapabilityRefusal("not_ready");

				const request = linkedSignal(deps.ambient, {
					parent: action.signal,
					ms: ASSISTANT_WAITS.request,
					reason: TIMEOUT,
				});
				try {
					const url = `https://maker.ifttt.com/trigger/${params.event}/with/key/${encodeURIComponent(grant.value)}`;
					try {
						const response = await bounded(
							Promise.resolve().then(() =>
								deps.fetch(url, {
									method: "POST",
									// A redirect would carry the key elsewhere.
									redirect: "manual",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										value1: params.value1,
										value2: params.value2,
										value3: params.value3,
									}),
									signal: request.signal,
								}),
							),
							request,
						);
						return { status: response.status, ok: response.ok };
					} catch (error) {
						if (error instanceof GatewayCapabilityRefusal) throw error;
						if (request.signal.aborted) throw new GatewayCapabilityRefusal("timeout");
						return { status: 0, ok: false };
					}
				} finally {
					request.dispose();
				}
			} finally {
				action.dispose();
			}
		},
	};
}
