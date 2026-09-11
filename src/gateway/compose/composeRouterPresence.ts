// The Router presence dirty hook, and the teardown an unlink or untrust runs on this Gateway.

import type { CrossDomainUnlinkResult } from "../../shared/console-protocol.js";
import type { FederationSlice } from "../boot.js";
import type { FederationStage } from "./composeFederation.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";

export interface RouterPresenceStageDeps {
	stores: Pick<StoresStage, "jobs">;
	sessions: Pick<SessionsStage, "presence">;
	federation: Pick<FederationStage, "markPresenceDirty">;
}

export interface RouterPresenceBuild {
	unlinkDomain: (domainId: string) => CrossDomainUnlinkResult;
	untrustOwner: (ownerSignPub: string) => CrossDomainUnlinkResult;
}

export interface RouterPresenceStage {
	build: (slice: FederationSlice) => RouterPresenceBuild;
}

export function composeRouterPresence(deps: RouterPresenceStageDeps): RouterPresenceStage {
	const { stores, sessions } = deps;

	function build(slice: FederationSlice): RouterPresenceBuild {
		sessions.presence.onMarkDirty(() => deps.federation.markPresenceDirty());

		// Count shares before unlink.
		const sharesNaming = (domainId: string): number =>
			slice.shareState.all().filter((s) => s.target.kind === "domain" && s.target.domainId === domainId).length;

		const unlinkDomain = (domainId: string): CrossDomainUnlinkResult => ({
			peersRemoved: slice.crossDomainPeers.removeByDomain(domainId),
			sharesDropped: sharesNaming(domainId),
			jobsExpired: stores.jobs.expireByDomain(domainId),
		});

		const untrustOwner = (ownerSignPub: string): CrossDomainUnlinkResult => {
			const { removed, domains } = slice.crossDomainPeers.removeByOwner(ownerSignPub);
			let sharesDropped = 0;
			let jobsExpired = 0;
			for (const domainId of domains) {
				sharesDropped += sharesNaming(domainId);
				jobsExpired += stores.jobs.expireByDomain(domainId);
			}
			return { peersRemoved: removed, sharesDropped, jobsExpired };
		};

		return { unlinkDomain, untrustOwner };
	}

	return { build };
}
