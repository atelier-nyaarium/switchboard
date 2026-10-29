// The assistant's home: the phone's choice and the named Gateway's report on it.

import {
	ASSISTANT_HOME_SEALED_MAX_BYTES,
	type AssistantHomePutResult,
	type AssistantHomePutValue,
	type AssistantHomeReadResult,
	type AssistantHomeRecord,
	type AssistantHomeReport,
	AssistantHomeReportParamsSchema,
} from "../../shared/schemasAssistantHome.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import { appliedOrUncertain } from "../../shared/write-result.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined, type StateRecord } from "../owner/ownerStateStore.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../ownerServiceHooks.js";

const KIND = "assistant.home";
const CHOICE = "choice";
const REPORT = "report";

type Deps = {
	registry: OwnerStoreRegistry;
	/** Admitted, registered now, and reachable by a pushed frame. */
	routable: (domainId: string, gatewayId: string) => boolean;
	/** Every applied write moves the owner's plane. */
	pokeOwner?: (domainId: string, version: number) => void;
};

const recordOf = (row: StateRecord | null): AssistantHomeRecord | null =>
	row
		? {
				version: row.version,
				gatewayId: typeof row.clear.gatewayId === "string" ? row.clear.gatewayId : null,
				sealed: (row.sealed?.home as ContentEnvelope | undefined) ?? null,
			}
		: null;

const reportOf = (row: StateRecord | null): AssistantHomeReport | null =>
	row ? (row.clear as unknown as AssistantHomeReport) : null;

export function createAssistantHomeService(deps: Deps) {
	let hooks: OwnerServiceHooks | null = null;
	const storeOf = (domainId: string) => deps.registry.for(domainId);

	/** A report shows only beside the choice it answers. */
	const read = (domainId: string): AssistantHomeReadResult => {
		const store = storeOf(domainId);
		const record = recordOf(store.get(KIND, CHOICE));
		const report = reportOf(store.get(KIND, REPORT));
		const current = record && report?.version === record.version && report.gatewayId === record.gatewayId;
		return { record, report: current ? report : null };
	};

	/** Both rows only grow, so their sum orders every write. */
	const planeVersion = (domainId: string): number => {
		const store = storeOf(domainId);
		return (store.get(KIND, CHOICE)?.version ?? 0) + (store.get(KIND, REPORT)?.version ?? 0);
	};

	const announce = (domainId: string, record: AssistantHomeRecord) => {
		if (!hooks) return;
		for (const gatewayId of hooks.connectedGateways(domainId))
			hooks.pushFrameTo(domainId, gatewayId, { type: "assistant_home", record });
	};

	const put = (domainId: string, value: AssistantHomePutValue): AssistantHomePutResult => {
		const store = storeOf(domainId);
		const current = store.get(KIND, CHOICE);
		const held = recordOf(current);
		if ((current?.version ?? 0) !== value.baseVersion) return { outcome: "conflict", record: held };
		if (value.sealed && Buffer.byteLength(value.sealed.ciphertext, "base64") > ASSISTANT_HOME_SEALED_MAX_BYTES)
			return { outcome: "refused", record: held, refusal: "too_large" };
		if (value.gatewayId !== null && !deps.routable(domainId, value.gatewayId))
			return { outcome: "refused", record: held, refusal: "unroutable" };
		const result = store.put(KIND, CHOICE, current?.version ?? null, {
			clear: { gatewayId: value.gatewayId },
			...(value.sealed ? { sealed: { home: value.sealed } } : {}),
		});
		if (result.kind === "conflict") return { outcome: "conflict", record: recordOf(result.current) };
		// An uncertain write may stand, so it is announced like one that landed.
		if (!appliedOrUncertain(result)) return { outcome: "refused", record: held, refusal: "durability_failure" };
		const record: AssistantHomeRecord = {
			version: (current?.version ?? 0) + 1,
			gatewayId: value.gatewayId,
			sealed: value.sealed,
		};
		deps.pokeOwner?.(domainId, planeVersion(domainId));
		announce(domainId, record);
		return { outcome: "applied", record };
	};

	/** The first report for a choice stands; a resend repeats it. */
	const report = (reg: GatewayRegistration, params: Record<string, unknown>) => {
		const parsed = AssistantHomeReportParamsSchema.parse(params);
		// Superseded connections cannot report.
		if (hooks?.gatewayIncarnation(reg.domainId, reg.gatewayId) !== reg.incarnation) return { accepted: false };
		const store = storeOf(reg.domainId);
		const record = recordOf(store.get(KIND, CHOICE));
		if (record?.gatewayId !== reg.gatewayId || record.version !== parsed.version) return { accepted: false };
		const held = store.get(KIND, REPORT);
		const prior = reportOf(held);
		if (prior?.version === parsed.version && prior.gatewayId === reg.gatewayId) return { accepted: true };
		const next: AssistantHomeReport = {
			version: parsed.version,
			gatewayId: reg.gatewayId,
			outcome: parsed.outcome,
			...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
		};
		const result = store.put(KIND, REPORT, held?.version ?? null, { clear: next });
		if (!appliedOrUncertain(result)) return { accepted: false };
		deps.pokeOwner?.(reg.domainId, planeVersion(reg.domainId));
		return { accepted: true };
	};

	const register = (registered: OwnerServiceHooks) => {
		hooks = registered;
		registered.ownerOp("assistant_home_read", (op) => read(op.domainId));
		registered.ownerOp("assistant_home_put", (op, value) => put(op.domainId, value));
		registered.gatewayFrame("assistant_home_read", "read", (reg: GatewayRegistration) => {
			try {
				return { record: read(reg.domainId).record };
			} catch (error) {
				if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
				throw error;
			}
		});
		registered.gatewayFrame("assistant_home_report", "value", report);
	};

	return { read, put, report, planeVersion, register };
}
