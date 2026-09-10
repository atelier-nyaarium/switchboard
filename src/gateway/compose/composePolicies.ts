import { openDurable } from "../../shared/durable-store.js";
import type { PolicyConsoleHandlers } from "../console/consoleTypes.js";
import { createPolicyStore, type PolicyStore } from "../policies/store.js";

export interface PolicyStageDeps {
	dataDir: string;
	/** Read late. */
	onPolicyMoved?: (policyId: string) => void;
}

export interface PolicyStage {
	console: PolicyConsoleHandlers;
	/** The resolver reads `byKey` here. */
	store: PolicyStore;
}

export function composePolicies(deps: PolicyStageDeps): PolicyStage {
	const store = openDurable(deps.dataDir, "policies", (durable) =>
		createPolicyStore({ store: durable, onChanged: (policyId) => deps.onPolicyMoved?.(policyId) }),
	);
	return {
		store,
		console: {
			list: () => ({ policies: store.list() }),
			put: (policy, base) => store.put(policy, { base }),
			remove: (policyId, base) => store.remove(policyId, base),
			enable: (policyId, enabled, base) => store.setEnabled(policyId, enabled, base),
		},
	};
}
