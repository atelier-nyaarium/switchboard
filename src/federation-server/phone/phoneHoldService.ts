import {
	holdStanding,
	PhoneHoldFrameSchema,
	type PhoneHoldPlane,
	PhoneHoldPlaneSchema,
	type PhoneHoldRecord,
	PhoneHoldRecordSchema,
} from "../../shared/schemasPhoneHold.js";
import { appliedOrUncertain } from "../../shared/write-result.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined, type StateRecord } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

const KIND = "phone.hold";
const HOLDER_ID = "holder";

type Deps = {
	registry: OwnerStoreRegistry;
	pokeOwner?: (domainId: string, version: number, payload: PhoneHoldPlane) => void;
};

function recordOf(row: StateRecord | null): PhoneHoldRecord | null {
	if (!row || typeof row.clear.holder !== "string") return null;
	const parsed = PhoneHoldRecordSchema.safeParse({
		holder: row.clear.holder,
		label: row.clear.label,
		claimedAt: row.clear.claimedAt,
		version: row.version,
	});
	return parsed.success ? parsed.data : null;
}

export function createPhoneHoldService(deps: Deps) {
	let hooks: OwnerServiceHooks | null = null;
	const storeOf = (domainId: string) => deps.registry.for(domainId);

	const planeVersion = (domainId: string): number => storeOf(domainId).get(KIND, HOLDER_ID)?.version ?? 0;

	const read = (domainId: string, now = deps.registry.now()): PhoneHoldRecord | null => {
		const hold = recordOf(storeOf(domainId).get(KIND, HOLDER_ID));
		return holdStanding(hold, now) === "held" ? hold : null;
	};

	/** Kept until swept. */
	const plane = (domainId: string): PhoneHoldPlane =>
		PhoneHoldPlaneSchema.parse({ hold: recordOf(storeOf(domainId).get(KIND, HOLDER_ID)) });

	const announce = (domainId: string, version: number, hold: PhoneHoldRecord | null): void => {
		const payload = PhoneHoldPlaneSchema.parse({ hold });
		deps.pokeOwner?.(domainId, version, payload);
		if (!hooks) return;
		for (const gatewayId of hooks.connectedGateways(domainId)) {
			const incarnation = hooks.gatewayIncarnation(domainId, gatewayId);
			if (incarnation === null) continue;
			const frame = PhoneHoldFrameSchema.parse({ type: "phone_hold", incarnation, hold });
			hooks.pushFrameTo(domainId, gatewayId, frame);
		}
	};

	/** Key decides; label displays. */
	const claim = (domainId: string, signer: string, label: string, now: number): { hold: PhoneHoldRecord } => {
		const store = storeOf(domainId);
		for (;;) {
			const current = store.get(KIND, HOLDER_ID);
			const result = store.put(KIND, HOLDER_ID, current?.version ?? null, {
				clear: { holder: signer, label, claimedAt: now },
			});
			if (result.kind === "conflict") continue;
			if (!appliedOrUncertain(result)) throw new OwnerOpRefused("durability_failure");
			const hold = PhoneHoldRecordSchema.parse({
				holder: signer,
				label,
				claimedAt: now,
				version: (current?.version ?? 0) + 1,
			});
			announce(domainId, hold.version, hold);
			return { hold };
		}
	};

	const sweep = (domainId: string, now: number): void => {
		const store = storeOf(domainId);
		const current = store.get(KIND, HOLDER_ID);
		const hold = recordOf(current);
		if (!current || !hold || holdStanding(hold, now) !== "lapsed") return;
		const result = store.put(KIND, HOLDER_ID, current.version, { clear: { holder: null } });
		if (result.kind === "conflict" || !appliedOrUncertain(result)) return;
		announce(domainId, current.version + 1, null);
	};

	const register = (registered: OwnerServiceHooks): void => {
		hooks = registered;
		registered.ownerOp("hold_claim", (op) => claim(op.domainId, op.signerSignPub, op.device, deps.registry.now()));
		registered.ownerOp("phone_hold_read", (op) => plane(op.domainId));
		registered.gatewayFrame("phone_hold_read", "read", (reg) => {
			try {
				return plane(reg.domainId);
			} catch (error) {
				if (error instanceof OwnerQuarantined) return { outcome: "durability_uncertain" as const };
				throw error;
			}
		});
		registered.onSweep("phone hold", sweep);
	};

	return { claim, read, plane, planeVersion, sweep, register };
}
