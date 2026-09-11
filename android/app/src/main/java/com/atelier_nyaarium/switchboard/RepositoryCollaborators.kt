package com.atelier_nyaarium.switchboard

import android.net.Uri
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePeekResult
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookFireTarget
import com.atelier_nyaarium.switchboard.proto.SignedDeleteDomain
import com.atelier_nyaarium.switchboard.proto.SignedProvisionTenant
import com.atelier_nyaarium.switchboard.proto.SignedRemoveTenant
import com.atelier_nyaarium.switchboard.proto.SignedSetDisplayName
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import com.atelier_nyaarium.switchboard.proto.SttsProvider
import com.atelier_nyaarium.switchboard.proto.ScheduledTarget
import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.crypto.scheduledBodyAadKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import com.atelier_nyaarium.switchboard.board.BoardManager
import com.atelier_nyaarium.switchboard.board.BoardRouterWriter

internal class ChatRepositoryEnrollCeremonyCollaborators(private val repo: ChatRepository) : EnrollCeremonyOpsCollaborators {
	override fun enrollInvites() = repo.enrollInvites
	override fun ownerBoxPub() = repo.federation.ownerBoxPub()
	override fun freshEnrollSalt() = repo.federation.freshEnrollSalt()
	override fun addTrustedOwner(ownerSignPub: String) = repo.federation.addTrustedOwner(ownerSignPub)
	override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String) =
		repo.ownerFacts.submitXdomainLink(srcDomainId, dstDomainId, edgeNonce)
}

internal class ChatRepositoryDeviceApprovalCollaborators(private val repo: ChatRepository) : DeviceApprovalOpsCollaborators {
	override fun approvalNonces() = repo.approvalNonces
	override fun installApprovedDevice(
		blob: String,
		domainJson: String?,
		domainVersion: String?,
		contentKeys: Map<Int, ByteArray>,
		domainId: String?,
	) = repo.identity.installApproved(blob, domainJson, domainVersion, contentKeys, domainId)
	override fun invalidateClients() {
		repo.invalidateClient()
		repo.sttsClient = null
	}
	override suspend fun submitOwnerAdmission(signed: SignedAdmission) =
		repo.ownerFacts.submitOwnerFact(
		 signed,
		 { repo.client().enroll(com.atelier_nyaarium.switchboard.proto.EnrollOp.SubmitAdmission(it)) },
		 repo.identity::mergeAdmission,
		"Approve failed",
	)
	override fun reportError() = repo._state.value.error
}

internal class ChatRepositoryDomainAdminCollaborators(private val repo: ChatRepository) : DomainAdminOpsCollaborators {
	override fun enrollInvites() = repo.enrollInvites
	override fun ownerBoxPub() = repo.federation.ownerBoxPub()
	override fun freshHandshakeId() = repo.federation.freshHandshakeId()
	override fun freshEnrollPin() = repo.federation.freshEnrollPin()
	override fun newDomainId() = repo.federation.newDomainId()
	override fun signSetDisplayName(domainId: String, name: String, nowMs: Long): SignedSetDisplayName =
		repo.federation.signSetDisplayName(domainId, name, nowMs)
	override fun signDeleteDomain(domainId: String, nowMs: Long): SignedDeleteDomain =
		repo.federation.signDeleteDomain(domainId, nowMs)
	override fun signProvisionTenant(domainId: String, name: String, nowMs: Long): SignedProvisionTenant =
		repo.federation.signProvisionTenant(domainId, name, nowMs)
	override fun signRemoveTenant(domainId: String, nowMs: Long): SignedRemoveTenant =
		repo.federation.signRemoveTenant(domainId, nowMs)
	override suspend fun clearAll() {
		repo.clearAll()
	}
}

internal class ChatRepositoryGoalCollaborators(private val repo: ChatRepository) : GoalOpsCollaborators {
	override suspend fun send(team: String, text: String, uris: List<Uri>) = repo.send(team, text, uris)
	override suspend fun peekTerminal(team: String): Result<ConsolePeekResult> = repo.sessions.peekTerminal(team, null)
	override suspend fun tmuxSend(team: String, text: String?, key: String?, submit: Boolean) =
		repo.sessions.tmuxSend(team, text, key, submit)
}

internal class ChatRepositoryScheduledSendCollaborators(private val repo: ChatRepository) : ScheduledSendOpsCollaborators {
	override fun admitPicked(uris: List<Uri>, bucket: String) = repo.admitPicked(uris, bucket)
	override fun fromCanonical(team: String) = repo.fromCanonical(team)
	override fun scheduleAttachmentDelete(srcs: List<String>) = repo.attachments.scheduleAttachmentDelete(srcs)
	override fun takeBackIntoDraft(team: String, text: String, files: List<MessageFile>) = repo.takeBackIntoDraft(team, text, files)
	override fun append(team: String, message: Message) = repo.append(team, message)
	override suspend fun postOwnerOp(op: JsonObject, opId: String): JsonElement? = repo.client().postOwnerOp(repo.ownerOps.sign(op, opId))
	override fun sealScheduledBody(plaintext: ByteArray, opId: String): ContentEnvelope? {
		val boot = repo.readyOrNull() ?: return null
		val epoch = boot.contentKeyring.epochs().maxOrNull() ?: return null
		val key = boot.contentKeyring.keyFor(epoch) ?: return null
		return Crypto.sealContent(plaintext, key, Crypto.ContentAad(boot.domainId, boot.ownerSignPub, epoch, scheduledBodyAadKind(boot.conversationId, opId)))
	}
	override fun openScheduledBody(body: ContentEnvelope, opId: String): ByteArray? = runCatching {
		val boot = repo.readyOrNull() ?: return null
		val key = boot.contentKeyring.keyFor(body.epoch.toInt()) ?: return null
		Crypto.openContent(body, key, Crypto.ContentAad(boot.domainId, boot.ownerSignPub, body.epoch.toInt(), scheduledBodyAadKind(boot.conversationId, opId)))
	}.getOrNull()
	override fun targetOf(team: String): ScheduledTarget? {
		val parsed = runCatching { com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget(team) as Address }.getOrNull() ?: return null
		return ScheduledTarget(parsed.domain, parsed.gateway, parsed.spawn + "." + parsed.session)
	}
	override fun teamOf(target: ScheduledTarget): String? = repo.state.value.teams.firstOrNull { targetOf(it.name) == target }?.name
	override suspend fun uploadFile(file: MessageFile): String = repo.client().uploadSealedBlob(Attachments.fileFor(repo.filesDir, file.src) ?: error("missing scheduled file"))
	override suspend fun fetchFile(file: MessageFile, bucket: String): MessageFile? = runCatching {
		val blobId = file.blobId ?: return null
		val client = repo.client()
		val src = Attachments.land(repo.filesDir, bucket, file.name, client.downloadBlob(blobId)) ?: return null
		client.forgetBlob(blobId)
		file.copy(src = src)
	}.getOrNull()
}

internal class ChatRepositoryAttachmentCollaborators(private val repo: ChatRepository) : AttachmentOpsCollaborators {
	override fun clientOrNull() = repo.clientOrNull()
	override fun attachmentBuckets() = repo.boardOps.attachmentBuckets()
}

internal class ChatRepositoryBoardCollaborators(private val repo: ChatRepository) : BoardOpsCollaborators {
	override val board: BoardManager get() = repo.board
	override val sessions: SessionOps get() = repo.sessions
	override val attachmentHost: AttachmentHost get() = repo.attachmentHost
	override val boardRouter: BoardRouterWriter get() = repo.boardRouter
	override fun boardSealing() = repo.boardSealing()
	override fun admitPicked(uris: List<Uri>, name: String) = repo.admitPicked(uris, name)
	override fun localDomain() = repo.localDomain()
	override val client: ConsoleClient? get() = repo.clientOrNull()
	override fun command(block: suspend () -> Unit) = repo.command { block() }
}

internal class ChatRepositoryRunbookHost(private val repo: ChatRepository) : RunbookHost {
	private val sandbox by lazy { SandboxRunbookGateway() }

	override val gateway: RunbookGateway? get() =
		if (isSandbox) sandbox else repo.clientOrNull()?.let(::ConsoleRunbookGateway)
	override val library get() = repo.runbooks
}

/** The port over the console client's routine calls. */
internal class ConsoleRoutineGateway(private val client: ConsoleClient) : RoutineGateway {
	override suspend fun list(gatewayId: String) = client.routineList(gatewayId)

	override suspend fun put(gatewayId: String, routine: Routine, baseRevision: Long?) =
		client.routinePut(gatewayId, routine, baseRevision)

	override suspend fun next(gatewayId: String, routine: Routine) = client.routineNext(gatewayId, routine)

	override suspend fun delete(gatewayId: String, routineId: String) = client.routineDelete(gatewayId, routineId)

	override suspend fun enable(gatewayId: String, routineId: String, enabled: Boolean, baseRevision: Long) =
		client.routineEnable(gatewayId, routineId, enabled, baseRevision)

	override suspend fun runNow(gatewayId: String, routineId: String, occurrenceId: String) =
		client.routineRunNow(gatewayId, routineId, occurrenceId)

	override suspend fun run(gatewayId: String, routineId: String) = client.routineRun(gatewayId, routineId)

	override suspend fun dismiss(gatewayId: String, routineId: String, occurrenceId: String) =
		client.routineDismiss(gatewayId, routineId, occurrenceId)
}

internal class ChatRepositoryRoutineHost(private val repo: ChatRepository) : RoutineHost {
	override fun onRoutinesChanged() = repo.notifyRoutinesChanged()
	// The sandbox answers as a Gateway would, so a screen that only appears on a refusal is reachable.
	private val sandbox by lazy { SandboxRoutineGateway() }

	override val gateway: RoutineGateway? get() =
		if (isSandbox) sandbox else repo.clientOrNull()?.let(::ConsoleRoutineGateway)
}

/** The port over the console client's policy calls. */
internal class ConsolePolicyGateway(private val client: ConsoleClient) : PolicyGateway {
	override suspend fun list(gatewayId: String) = client.policyList(gatewayId)

	override suspend fun put(gatewayId: String, policy: AuthorizationPolicy, baseRevision: Long?) =
		client.policyPut(gatewayId, policy, baseRevision)

	override suspend fun delete(gatewayId: String, policyId: String, baseRevision: Long) =
		client.policyDelete(gatewayId, policyId, baseRevision)

	override suspend fun enable(gatewayId: String, policyId: String, enabled: Boolean, baseRevision: Long) =
		client.policyEnable(gatewayId, policyId, enabled, baseRevision)
}

internal class ChatRepositoryPolicyHost(private val repo: ChatRepository) : PolicyHost {
	// One shelf, so a mutation there survives the read after it.
	private val sandbox by lazy { SandboxPolicyGateway() }

	override val gateway: PolicyGateway? get() =
		if (isSandbox) sandbox else repo.clientOrNull()?.let(::ConsolePolicyGateway)
}

/** The port over the console client's runbook calls. */
internal class ConsoleRunbookGateway(private val client: ConsoleClient) : RunbookGateway {
	override suspend fun list(gatewayId: String) = client.runbookList(gatewayId)

	override suspend fun put(gatewayId: String, runbook: Runbook, baseRevision: Long?, overwrite: Boolean) =
		client.runbookPut(gatewayId, runbook, baseRevision, overwrite)

	override suspend fun delete(gatewayId: String, runbookId: String) = client.runbookDelete(gatewayId, runbookId)

	override suspend fun preview(gatewayId: String, runbookId: String, values: Map<String, String>) =
		client.runbookPreview(gatewayId, runbookId, values)

	override suspend fun fire(
		gatewayId: String,
		runbookId: String,
		values: Map<String, String>,
		into: RunbookFireTarget,
		previewedRevision: Long?,
	) = client.runbookFire(gatewayId, runbookId, values, into, previewedRevision)
}

internal class ChatRepositoryVaultCollaborators(private val repo: ChatRepository) : VaultOpsCollaborators {
	override val vault: com.atelier_nyaarium.switchboard.vault.VaultManager get() = repo.vault
	override val writer: com.atelier_nyaarium.switchboard.vault.VaultRouterWriter get() = repo.vaultRouter
	override fun sealing() = repo.vaultSealing()
	override val client: ConsoleClient? get() = repo.clientOrNull()
	override val gate: com.atelier_nyaarium.switchboard.vault.ApprovalGate get() = repo.approvalGate
}

internal class ChatRepositoryTrustCollaborators(private val repo: ChatRepository) : TrustOpsCollaborators {
	override suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String) =
		repo.ownerFacts.submitXdomainLink(srcDomainId, dstDomainId)
	override suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String) =
		repo.ownerFacts.revokeXdomainLink(srcDomainId, dstDomainId)
	override suspend fun routerReachable() = runCatchingCancellable { repo.client().transport.apiReachable() }.getOrNull() != null
}

internal class ChatRepositoryPlaybackPort(private val repo: ChatRepository) : PlaybackPort {
	override val stts: SttsPlayer get() = repo.stts
	override fun sttsClient() = repo.sttsClient()
	override fun currentProvider(): SttsProvider? = repo.currentProvider()
	override fun sttsVoiceFor(providerId: String) = repo.sttsVoiceFor(providerId)
	override val sttsVolume: Int get() = repo.sttsVolume
	override val sttsChimeVolume: Int get() = repo.sttsChimeVolume
	override val sttsAutoPlay: String get() = repo.sttsAutoPlay
	override fun sttsReady() = repo.sttsReady()
}

internal class ChatRepositoryPlaybackCollaborators(private val repo: ChatRepository) : PlaybackOpsCollaborators {
	override fun openThread(team: String) = repo.openThread(team)
}
