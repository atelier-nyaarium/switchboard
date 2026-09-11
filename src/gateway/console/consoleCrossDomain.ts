import type { DomainSnapshot } from "../../shared/admission.js";
import type { ConsoleOp, CrossDomainListPeersResult, CrossDomainUnlinkResult } from "../../shared/console-protocol.js";
import type { CrossDomainConsoleHandlers } from "./consoleTypes.js";

export interface CrossDomainOpsDeps {
	domain?: () => { version: string; snapshot: DomainSnapshot } | null;
	crossDomain?: CrossDomainConsoleHandlers;
	unlinkDomain?: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner?: (ownerSignPub: string) => CrossDomainUnlinkResult;
}

export function createCrossDomainHandlers({ domain, crossDomain, unlinkDomain, untrustOwner }: CrossDomainOpsDeps) {
	return {
		listen(_op: Extract<ConsoleOp, { kind: "cross_domain_listen" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listen();
		},

		async request(op: Extract<ConsoleOp, { kind: "cross_domain_request" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			const root = domain?.()?.snapshot.ownerSignPub;
			// Cross-Domain requests are signed by the Domain root, not the device.
			if (!root) throw new Error("this Gateway has no Domain owner yet");
			return crossDomain.request({
				listeningToken: op.listeningToken,
				pin: op.pin,
				requesterOwnerSignPub: root,
				requesterDomainId: op.requesterDomainId,
			});
		},

		confirm(op: Extract<ConsoleOp, { kind: "cross_domain_confirm" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.confirm({
				pin: op.pin,
				mySignedLink: op.mySignedLink,
			});
		},

		listenState(op: Extract<ConsoleOp, { kind: "cross_domain_listen_state" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listenState(op.listeningToken);
		},

		cancel(op: Extract<ConsoleOp, { kind: "cross_domain_cancel" }>) {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return { cancelled: crossDomain.cancel({ listeningToken: op.listeningToken, pin: op.pin }) };
		},

		listPeers(_op: Extract<ConsoleOp, { kind: "cross_domain_list_peers" }>): CrossDomainListPeersResult {
			if (!crossDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return crossDomain.listPeers();
		},

		unlink(op: Extract<ConsoleOp, { kind: "cross_domain_unlink" }>) {
			if (!unlinkDomain) throw new Error("cross-Domain linking is not available on this Gateway");
			return unlinkDomain(op.domainId);
		},

		untrust(op: Extract<ConsoleOp, { kind: "cross_domain_untrust" }>) {
			if (!untrustOwner) throw new Error("cross-Domain linking is not available on this Gateway");
			return untrustOwner(op.ownerSignPub);
		},
	};
}
