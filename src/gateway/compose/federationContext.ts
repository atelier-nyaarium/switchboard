// The gateway's one federation reader.

import type { GatewayBootstrap } from "../boot.js";
import { type ArmingSlice, armingOf, type BootState, type FederationSlice, federationOf } from "../boot.js";
import type { Allowlist } from "../federation/allowlist.js";
import type { ContentKeyStore } from "../federation/contentKeyStore.js";
import type { RouterTransport } from "../router/transport.js";

export interface FederationContextDeps {
	/** The keyring, live before enrollment and shared with the active slice. */
	contentKeys: ContentKeyStore;
	/** The Domain id before any enrollment delivers one. */
	initialDomainId: string | null;
	/** The Domain id on disk right now, read again after an install. */
	domainIdOnDisk: () => string | null;
	buildSlice: (boot: GatewayBootstrap) => FederationSlice;
	/** Runs once the slice is published, never before. */
	onActivate: (slice: FederationSlice) => void;
	/** Presence reads the Domain id, so a change announces itself. */
	onDomainChanged?: () => void;
}

export class FederationContext {
	private state: BootState = { phase: "standalone" };
	private activeBoot: GatewayBootstrap | null = null;
	private domain: string | null;

	constructor(private readonly deps: FederationContextDeps) {
		this.domain = deps.initialDomainId;
	}

	bootState(): BootState {
		return this.state;
	}

	slice(): FederationSlice | null {
		return federationOf(this.state);
	}

	arming(): ArmingSlice | null {
		return armingOf(this.state);
	}

	domainId(): string | null {
		return this.domain;
	}

	/** The Domain id, on a road that only runs once one is active. */
	activeDomainId(): string {
		if (this.domain === null) throw new Error("no Domain is active on this Gateway");
		return this.domain;
	}

	boot(): GatewayBootstrap | null {
		return this.activeBoot;
	}

	transport(): RouterTransport | null {
		return this.activeBoot?.transport ?? null;
	}

	routerCertFp(): string | undefined {
		return this.activeBoot?.transport.routerCertFp;
	}

	allowlist(): Allowlist | null {
		return this.activeBoot?.allowlist ?? null;
	}

	contentKeys(): ContentKeyStore {
		return this.deps.contentKeys;
	}

	/** The friend Domains this Gateway has linked, each listed once. */
	linkedDomainIds(): string[] {
		const peers = this.slice()?.crossDomainPeers.all() ?? [];
		return [...new Set(peers.map((peer) => peer.friendDomainId))];
	}

	isLinkedDomain(domainId: string): boolean {
		return (
			this.slice()
				?.crossDomainPeers.all()
				.some((peer) => peer.friendDomainId === domainId) ?? false
		);
	}

	arm(arming: ArmingSlice): void {
		this.state = { phase: "arming", arming };
	}

	/** Drops the boot and the slice; the Domain id falls back to what disk holds now. */
	standalone(): void {
		this.state = { phase: "standalone" };
		this.activeBoot = null;
		this.setDomain(this.deps.domainIdOnDisk());
	}

	/** Builds the slice first, so a failed build leaves the phase untouched. */
	activate(boot: GatewayBootstrap): void {
		if (this.state.phase === "federationActive") return;
		const slice = this.deps.buildSlice(boot);
		this.activeBoot = boot;
		this.setDomain(boot.domainId);
		this.state = { phase: "federationActive", federation: slice };
		this.deps.onActivate(slice);
	}

	/** The one write, so no road changes the Domain without saying so. */
	private setDomain(next: string | null): void {
		if (this.domain === next) return;
		this.domain = next;
		this.deps.onDomainChanged?.();
	}
}
