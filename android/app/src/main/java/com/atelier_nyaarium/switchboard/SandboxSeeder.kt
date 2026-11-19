package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import kotlinx.coroutines.flow.update

/** No Gateway, no Router, no network. */
internal val isSandbox: Boolean get() = BuildConfig.BUILD_TYPE == "emulator"

internal const val SANDBOX_UNREACHABLE = "no Gateway in the sandbox"

/** Unregistered Gateway has no port. */
internal const val SANDBOX_NEVER_REGISTERED = "shelved"

/** Sandbox roster includes one unregistered Gateway. */
internal fun sandboxRegistry(roster: List<String>, now: Long): GatewayRegistry =
	GatewayRegistry(
		provenance = RegistryProvenance.Current,
		epoch = 1,
		version = 1,
		coverage = DiscoverCoverage(
			rosterKnown = true,
			asked = roster.size + 1L,
			answered = roster.size.toLong(),
			unreachable = listOf(SANDBOX_NEVER_REGISTERED),
		),
		gateways = (roster.mapIndexed { index, id ->
			val spawns = sandboxHarnessSpawns(index)
			GatewayEntry(
				id,
				connected = true,
				incarnation = 1,
				lastRegisteredAt = now,
				hostSpawns = spawns.values.flatten().distinct(),
				harnessSpawns = spawns,
				containers = sandboxContainers(index),
			)
		} + GatewayEntry(SANDBOX_NEVER_REGISTERED, connected = false, incarnation = 0, lastRegisteredAt = 0))
			.sortedBy { it.id },
	)

/** Gateway `index` lacks the first `index` CLIs, so each answers differently. */
private fun sandboxHarnessSpawns(index: Int): Map<SessionHarness, List<String>> =
	SessionHarness.entries.associateWith { if (it.ordinal >= index) listOf("host") else emptyList() }

private val SANDBOX_PROVISIONING =
	"""{"transport":"direct","routerUrl":"https://router.sandbox.invalid:20001",""" +
		""""routerCertFp":"${"11".repeat(32)}","appToken":"sandbox","conversationId":"sandbox"}"""

/** Every identity fact a boot needs, so `Need` cannot outgrow the sandbox unseen. */
internal fun seedSandboxIdentity(identity: PhoneIdentity, domainId: String?) {
	if (identity.blob() == null) identity.saveBlob(SANDBOX_PROVISIONING)
	domainId?.let { identity.learnDomainId(it, SANDBOX_PROVISIONING) }
}

internal fun sandboxFailedSends(threads: Map<String, List<Message>>, tab: String?, now: Long): Map<String, List<Message>> {
	tab ?: return threads
	val failed = listOf(
		Message(true, "Can you rerun the deploy?", now - 120_000, status = "error", opId = "sandbox-failed", failReason = reasonSentence(Act.SENDING, "no_holder")),
		Message(
			true,
			"Morning standup notes",
			now - 60_000,
			status = "error",
			opId = "sandbox-scheduled-failed",
			failReason = reasonSentence(Act.SENDING_SCHEDULED, Protocol.Wire.ScheduledFailureReason.TARGET_MISMATCH),
		),
	)
	val held = threads[tab].orEmpty()
	if (held.any { it.opId == "sandbox-failed" }) return threads
	val nextId = (held.maxOfOrNull { it.id } ?: -1L) + 1
	return threads + (tab to held + failed.mapIndexed { i, m -> m.copy(id = nextId + i) })
}

internal fun sandboxNotices(tab: String?): List<Notice> =
	raiseNotice(emptyList(), settledSentence("fired"), scheduledNoticeKey(tab.orEmpty()), tab)
		.let { raiseNotice(it, keyEpochLine(3)) }

/** Seeded tabs, never the assistant. */
internal fun sandboxTabs(teams: List<Team>, threads: Map<String, List<Message>>): List<String> =
	threads.keys.filter { key -> teams.none { it.name == key && it.role == ASSISTANT_ROLE } }

internal interface SandboxSeeder {
	fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>> = emptyMap(),
		drafts: Map<String, Draft> = emptyMap(),
		goals: Map<String, PendingGoal> = emptyMap(),
		gateways: GatewayRegistry = GatewayRegistry(),
	)

	/** Entries sealed by this phone. */
	fun seedSandboxVault(drafts: List<com.atelier_nyaarium.switchboard.vault.VaultDraft>)
}

internal class ChatRepositorySandboxSeeder(private val repo: ChatRepository) : SandboxSeeder {
	@Volatile private var dirs: Map<String, List<String>>? = null
	val sandboxDirs: Map<String, List<String>>? get() = dirs

	/** No Router here: states the link it draws. */
	fun drawLink() {
		repo.noteRouter(RouterEvent.Accepted)
		repo.noteRouter(RouterEvent.SetupSettled)
	}

	override fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>>,
		drafts: Map<String, Draft>,
		goals: Map<String, PendingGoal>,
		gateways: GatewayRegistry,
	) {
		if (!isSandbox) return
		seedSandboxIdentity(repo.identity, teams.firstOrNull()?.domainId)
		seedPendingGateway()
		this.dirs = dirs
		drawLink()
		val tab = sandboxTabs(teams, threads).firstOrNull()
		val seeded = sandboxFailedSends(threads, tab, System.currentTimeMillis())
		repo._state.update { s ->
			s.copy(
				teams = teams,
				threads = seeded,
				openTabs = sandboxTabs(teams, seeded),
				roles = rolesAfter(s.roles, teams),
				unread = seeded.mapValues { (team, msgs) -> unreadCount(msgs, s.readAnchors[team]) },
				provisioned = true,
				notices = sandboxNotices(tab),
				drafts = drafts,
				goals = goals,
				gateways = gateways,
				owner = teams.firstOrNull()?.domainId?.let { OwnerFacts(it, null, false) },
			)
		}
	}

	/** One admitted Gateway whose setup never collected its bundle. */
	private fun seedPendingGateway() {
		runIsolated {
			val admitted = repo.federation.members().find { it.gatewayId == SANDBOX_NEVER_REGISTERED }?.signPub
				?: com.atelier_nyaarium.switchboard.crypto.Crypto.generateIdentity().also { gateway ->
					repo.identity.mergeAdmission(
						repo.federation.admitGateway(SANDBOX_NEVER_REGISTERED, gateway.sign.pub, gateway.box.pub, System.currentTimeMillis()),
					)
				}.sign.pub
			repo.gatewayEnroll.setups.note(
				PendingEnroll(SANDBOX_NEVER_REGISTERED, bundle = "{}", pickupId = bootstrapPickupId("sandbox"), gatewaySignPub = admitted),
			)
		}.onFailure { DebugLog.log("Sandbox", "pending Gateway seed failed: ${it.message}") }
	}

	override fun seedSandboxVault(drafts: List<com.atelier_nyaarium.switchboard.vault.VaultDraft>) {
		if (!isSandbox) return
		// No connect here derives the content keys, so a value would seal to nothing.
		repo.readyOrNull()?.let(repo.identity::ensureContentEpochs)
		val sealing = repo.vaultSealing() ?: return
		val now = System.currentTimeMillis()
		drafts.forEachIndexed { index, draft ->
			val id = draft.id ?: return@forEachIndexed
			if (repo.vault.stored(id) != null) return@forEachIndexed
			val sealed = com.atelier_nyaarium.switchboard.vault.sealDraft(draft, id, null, null, sealing)
			if (sealed == null) {
				DebugLog.log("Sandbox", "vault seed $id did not seal")
				return@forEachIndexed
			}
			val revision = index + 1L
			repo.vault.applyWrite(
				com.atelier_nyaarium.switchboard.proto.VaultStoredEntry(
					clear = com.atelier_nyaarium.switchboard.proto.VaultEntryClear(
						id = id,
						revision = 1L,
						tombstone = false,
						changedAt = revision,
						createdBy = "phone",
						createdAt = now,
						updatedAt = now,
					),
					sealed = sealed,
				),
				revision,
				generation = repo.vault.generation,
			)
		}
		// The seed is the list.
		val held = repo.vault.snapshot()
		repo.vault.applyList(
			com.atelier_nyaarium.switchboard.proto.VaultListResult(revision = held.revision, since = 0L, entries = held.stored),
			generation = repo.vault.generation,
		)
	}
}
