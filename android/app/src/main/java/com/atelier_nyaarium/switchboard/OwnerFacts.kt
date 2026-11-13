package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.EnrollOp
import com.atelier_nyaarium.switchboard.proto.EnrollResult
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

internal class OwnerFacts(private val repo: ChatRepository) {
	/** Roots a pending Domain. Rooted only once the Router accepts. */
	suspend fun firstRoot(): StepResult {
		val blob = repo.identity.blob() ?: return StepResult.Done
		val prov = runIsolated { ConsoleCredentials.parse(blob, repo.store) }.getOrNull() ?: return StepResult.Done
		return when (val decision = FriendOnboarding.decide(prov, repo.store.firstRooted)) {
			is FirstRootDecision.NotPending -> StepResult.Done
			is FirstRootDecision.Root -> {
				DebugLog.log("FirstRoot", "pending domain=${decision.domainId}; rooting at owner key ${repo.federation.ownerSas()}")
				val signed = repo.federation.signFirstRoot(decision.domainId, decision.nonce, System.currentTimeMillis())
				val result = runCatchingCancellable { repo.client().firstRoot(signed) }.getOrElse { return laterOf(it) }
				if (result.ok) {
					repo.identity.markFirstRooted(blob)
					repo.readyOrNull()?.let(repo.identity::ensureContentEpochs)
					DebugLog.log("FirstRoot", "rooted ok domain=${decision.domainId}")
					StepResult.Done
				} else {
					val reject = FriendOnboarding.classifyFirstRootError(result.error)
					DebugLog.log("FirstRoot", "rejected (transient=${reject.transient}): ${result.error?.take(120)}")
					if (reject.transient) StepResult.Later(reject.message) else StepResult.Refused(reject.message)
				}
			}
		}
	}

	fun ownerKeysForDisplay(): OwnerKeysView? = repo.federation.ownerKeysForDisplay()

	fun holdsOwnerKey(): Boolean = repo.federation.holdsDomainOwnerKey()

	// Scrypt stays off the main thread.
	suspend fun exportOwnerBackup(passphrase: String): String =
		withContext(Dispatchers.IO) { repo.federation.exportOwnerBackup(passphrase) }

	suspend fun importOwnerBackup(blob: String, passphrase: String): OwnerRestoreResult =
		withContext(Dispatchers.IO) { repo.identity.importOwnerBackup(blob, passphrase) }

	// Merge locally after Router acceptance while preserving cancellation.
	internal suspend fun <T> submitOwnerFact(
		signed: T,
		submit: suspend (T) -> EnrollResult,
		merge: (T) -> Unit,
		failLabel: String,
	): Boolean {
		val result = runCatchingCancellable { submit(signed) }.getOrElse {
			DebugLog.log("Enroll", "$failLabel: submit threw ${it.javaClass.simpleName}: ${it.message?.take(140)}")
			EnrollResult(ok = false, error = it.message)
		}
		if (!result.ok) {
			DebugLog.log("Enroll", "$failLabel: Router rejected: ${result.error?.take(140) ?: "unknown"}")
			repo._state.update { it.copy(error = "$failLabel: ${result.error?.take(120) ?: "unknown"}") }
			return false
		}
		merge(signed)
		runCatchingCancellable { repo.presence.refreshAfterAction() }
		return true
	}

	/** Submits this console's own admission, once. */
	suspend fun admitThisConsole(): StepResult {
		val blob = repo.identity.blob() ?: return StepResult.Done
		if (repo.store.consoleAdmitted) return StepResult.Done
		val signed = repo.federation.consoleAdmission(System.currentTimeMillis())
		DebugLog.log("Enroll", "submitting console admission to the Router (owner ${Crypto.fingerprint(signed.ownerSignPub)})")
		val result = runCatchingCancellable { repo.client().enrollAnswered(EnrollOp.SubmitAdmission(signed)) }.getOrElse { return laterOf(it) }
		if (!result.ok) {
			DebugLog.log("Enroll", "console admission rejected: ${result.error?.take(140) ?: "unknown"}")
			// The Router names no permanence, so it is asked again.
			return StepResult.Later(
				"Console admission rejected: ${result.error?.take(100) ?: "unknown"} - re-run setup.sh, then re-import the setup blob",
			)
		}
		repo.identity.mergeAdmission(signed)
		repo.identity.setConsoleAdmitted(true, blob)
		runCatchingCancellable { repo.presence.refreshAfterAction() }
		return StepResult.Done
	}

	suspend fun admitGateway(gatewayId: String, signPub: String, boxPub: String): SignedAdmission? =
		withContext(Dispatchers.IO) {
			val signed = repo.federation.admitGateway(gatewayId, signPub, boxPub, System.currentTimeMillis())
			if (!submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitAdmission(it)) }, repo.identity::mergeAdmission, "Admit failed")) {
				return@withContext null
			}
			signed
		}

	suspend fun revokeMember(signPub: String) = withContext(Dispatchers.IO) {
		val signed = repo.federation.revoke(signPub, System.currentTimeMillis())
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitRevocation(it)) }, repo.identity::mergeRevocation, "Revoke failed")
	}

	suspend fun submitXdomainLink(srcDomainId: String, dstDomainId: String, edgeNonce: String? = null): Boolean =
		withContext(Dispatchers.IO) {
			val signed = repo.federation.signXdomainLinkEdge(srcDomainId, dstDomainId, System.currentTimeMillis(), edgeNonce)
			submitOwnerFact(signed, { repo.client().enroll(EnrollOp.SubmitXdomainLink(it)) }, {}, "Link failed")
		}

	suspend fun revokeXdomainLink(srcDomainId: String, dstDomainId: String): Boolean = withContext(Dispatchers.IO) {
		val signed = repo.federation.signXdomainLinkRevocation(srcDomainId, dstDomainId, System.currentTimeMillis())
		submitOwnerFact(signed, { repo.client().enroll(EnrollOp.RevokeXdomainLink(it)) }, {}, "Unlink failed")
	}

	fun admittedMembers(): List<MemberInfo> = repo.federation.members()
}
