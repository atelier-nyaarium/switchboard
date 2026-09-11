import type { Ambient } from "../../shared/ambient.js";
import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import type { SealedEnvelope } from "../../shared/crypto.js";
import type { FederatedOp } from "../../shared/federation-protocol.js";
import { BLOB_HOLD_MAX_MS } from "../../shared/router-protocol.js";
import { signRowEnvelope } from "../../shared/schemasInbox.js";
import { parseSessionName } from "../../shared/session-id.js";
import type { GatewayConfig } from "../../shared/types.js";
import { OP_OUTCOME_ACCEPTED } from "../../shared/wire-vocabulary.js";
import { sealTargetFor } from "../federation/sealTarget.js";
import { holdIdFor } from "../router/blobUploader.js";

export interface RelayDeps {
	config: GatewayConfig;
	localDomain: string;
	producerSignPriv?: string;
	routerClient?: import("../router/routerClient.js").RouterClient | null;
	sealer?: import("../federation/sealer.js").Sealer | null;
	blobUploader?: ReturnType<typeof import("../router/blobUploader.js").createBlobUploader>;
	crossDomainPeers?: import("../federation/crossDomainPeers.js").CrossDomainPeers | null;
	resolvesLocalGateway?: ((gatewayId: string) => boolean) | null;
	ambient: Pick<Ambient, "newId" | "setTimer">;
}

export type Relay = ReturnType<typeof createRelay>;

export function createRelay(deps: RelayDeps) {
	const {
		config,
		localDomain,
		producerSignPriv,
		routerClient,
		sealer,
		blobUploader,
		crossDomainPeers,
		resolvesLocalGateway,
		ambient,
	} = deps;
	const { localGatewayId, localDomainId } = config;

	function targetDomainId(targetGateway: string, targetDomain?: string): string | null {
		try {
			const target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, targetGateway, targetDomain);
			return typeof target === "string" ? null : target.domainId;
		} catch {
			return null;
		}
	}

	/** Stages local files for relay; a retry renews the same holds. */
	async function withHeldFiles(
		op: FederatedOp,
		sameDomain: boolean,
		opId: string,
	): Promise<{ ok: true; op: FederatedOp } | { ok: false; error: string }> {
		if ((op.kind !== "send" && op.kind !== "response_push") || !op.files?.length) return { ok: true, op };
		if (!sameDomain) return { ok: true, op: { ...op, files: op.files.map(({ blobId: _gone, ...file }) => file) } };
		const blobIds = [...new Set(op.files.flatMap((file) => (file.blobId ? [file.blobId] : [])))];
		if (!blobIds.length) return { ok: true, op };
		if (!blobUploader) return { ok: false, error: "blob staging is not available on this Gateway" };
		for (const blobId of blobIds) {
			const staged = await blobUploader.stage(blobId);
			if (staged.kind === "failed")
				return { ok: false, error: `attachment could not be staged: ${staged.error}` };
			if (staged.kind === "absent") return { ok: false, error: `attachment ${blobId} is no longer staged here` };
			if (!(await blobUploader.hold(blobId, holdIdFor(opId, blobId), BLOB_HOLD_MAX_MS)))
				return { ok: false, error: `attachment ${blobId} could not be held on the Router` };
		}
		return { ok: true, op };
	}

	async function relayToGateway(
		dstGateway: string,
		op: FederatedOp,
		dstDomain?: string,
		producerOpId?: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (!routerClient?.isConnected())
			return { ok: false, error: `Router unavailable; cannot reach Gateway "${dstGateway}"` };
		if (!sealer) return { ok: false, error: `federation crypto is not configured` };
		let target: import("../federation/sealer.js").SealTarget;
		let sealed: SealedEnvelope;
		const opId = producerOpId ?? ambient.newId();
		try {
			target = sealTargetFor({ resolvesLocalGateway, crossDomainPeers }, dstGateway, dstDomain);
			const carried = await withHeldFiles(op, typeof target === "string", opId);
			if (!carried.ok) return carried;
			sealed = sealer.seal(target, carried.op);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		if (typeof target !== "string" && (op.kind === "send" || op.kind === "response_push") && producerSignPriv) {
			const contentRefs: string[] = [];
			const envelope = {
				origin: { kind: "gateway" as const, domainId: localDomain, gatewayId: localGatewayId },
				opKey: {
					conversationId: sha256Hex(op.kind === "send" ? op.returnRoute.srcConversationId : op.session_id),
					opId,
				},
				epoch: "peer" as const,
				kind: op.kind === "send" ? ("message" as const) : ("reply" as const),
				contentRefs,
			};
			const targetParts = parseSessionName(op.kind === "send" ? op.to : op.session_id);
			const address = `session:${target.domainId}/${target.gatewayId}/${targetParts.project}.${targetParts.session}`;
			const result = await routerClient.callInboxTool("inbox_append", {
				address,
				row: { envelope, producerSig: signRowEnvelope(envelope, producerSignPriv), body: sealed },
				opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ address, op })) },
			});
			if (result.error) return { ok: false, error: result.error };
			const accepted = result.result as { outcome?: string; ok?: boolean; error?: string } | undefined;
			if (accepted?.ok === false) return { ok: false, error: accepted.error ?? "refused" };
			if (accepted?.outcome && accepted.outcome !== OP_OUTCOME_ACCEPTED)
				return { ok: false, error: accepted.outcome };
			return { ok: true, result: accepted };
		}
		const resolvedDstDomain = typeof target === "string" ? undefined : target.domainId;
		// Use the resolved Domain, not the caller's hint.
		const relayId = ambient.newId();
		const call = await routerClient.callTool("gateway_relay", {
			relayId,
			srcGateway: localGatewayId,
			dstGateway,
			srcDomain: localDomainId,
			payload: { sealed },
		});
		if (call.error) return { ok: false, error: call.error };
		const reply = call.result as { ok?: boolean; result?: unknown; error?: string } | undefined;
		if (!reply || reply.ok === false) return { ok: false, error: reply?.error ?? "cross-Gateway relay failed" };
		try {
			return { ok: true, result: sealer.open(dstGateway, reply.result as SealedEnvelope, resolvedDstDomain) };
		} catch (err) {
			return { ok: false, error: `bad sealed reply from "${dstGateway}": ${(err as Error).message}` };
		}
	}

	function relayWithRetry(
		dstGateway: string,
		op: FederatedOp,
		label: string,
		dstDomain?: string,
		producerOpId?: string,
	): Promise<{ ok: boolean; error?: string }> {
		const maxAttempts = 5;
		// Reuse one opId across retries.
		const opId = producerOpId ?? ambient.newId();
		let attempt = 0;
		return new Promise((resolveOutcome) => {
			const tryOnce = async (): Promise<void> => {
				let error: string | undefined;
				try {
					const r = await relayToGateway(dstGateway, op, dstDomain, opId);
					if (r.ok) {
						resolveOutcome({ ok: true });
						return;
					}
					error = r.error;
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				attempt += 1;
				if (attempt >= maxAttempts) {
					console.error(`[relay] ${label} to ${dstGateway} failed after ${maxAttempts} attempts: ${error}`);
					resolveOutcome({ ok: false, error });
					return;
				}
				ambient.setTimer(() => void tryOnce(), Math.min(2000 * 2 ** (attempt - 1), 30_000));
			};
			void tryOnce();
		});
	}

	return { targetDomainId, relayToGateway, relayWithRetry };
}
