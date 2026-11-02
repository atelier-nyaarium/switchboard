import { type Ambient, type Linked, linkedSignal } from "../../shared/ambient.js";
import { INTEGRATION_IDS } from "../../shared/schemasAssistant.js";
import type { IftttTriggerAnswer, IftttTriggerRequest } from "../../shared/schemasPhoneCapabilities.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import { GatewayCapabilityRefusal } from "./gatewayCapabilityRefusal.js";
import { ASSISTANT_WAITS } from "./waits.js";

const INTEGRATION_ID = INTEGRATION_IDS[0];
const TIMEOUT = "ifttt request timed out";

interface IftttClientDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	vault: {
		entryId: () => string | undefined;
		readForWatcher: (watcherId: string, entryId: string) => Promise<VaultRelease>;
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
		async trigger(params: IftttTriggerRequest): Promise<IftttTriggerAnswer> {
			const action = linkedSignal(deps.ambient, { ms: ASSISTANT_WAITS.action, reason: TIMEOUT });
			try {
				const entryId = deps.vault.entryId();
				if (entryId === undefined) throw new GatewayCapabilityRefusal("not_granted");
				let grant: VaultRelease;
				try {
					grant = await bounded(deps.vault.readForWatcher(INTEGRATION_ID, entryId), action);
				} catch (error) {
					if (error instanceof GatewayCapabilityRefusal) throw error;
					throw new GatewayCapabilityRefusal("not_ready");
				}
				if (grant.kind === "unusable") {
					throw new GatewayCapabilityRefusal(grant.status === 403 ? "not_granted" : "not_ready");
				}
				if (grant.kind !== "released") throw new GatewayCapabilityRefusal("not_ready");

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
