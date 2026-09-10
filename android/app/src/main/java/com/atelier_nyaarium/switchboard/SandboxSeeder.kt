package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import kotlinx.coroutines.flow.update

/** No Gateway, no Router, no network. */
internal val isSandbox: Boolean get() = BuildConfig.BUILD_TYPE == "emulator"

internal const val SANDBOX_UNREACHABLE = "no Gateway in the sandbox"

internal fun sandboxHomeGateway(firstTeam: String?, current: String): String =
	firstTeam?.split(".")?.getOrNull(1) ?: current

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
		gateways = (roster.map { GatewayEntry(it, connected = true, incarnation = 1, lastRegisteredAt = now) } +
			GatewayEntry(SANDBOX_NEVER_REGISTERED, connected = false, incarnation = 0, lastRegisteredAt = 0))
			.sortedBy { it.id },
	)

private val SANDBOX_PROVISIONING =
	"""{"transport":"direct","routerUrl":"https://router.sandbox.invalid:20001",""" +
		""""routerCertFp":"${"11".repeat(32)}","appToken":"sandbox","conversationId":"sandbox"}"""

/** Every identity fact a boot needs, so `Need` cannot outgrow the sandbox unseen. */
internal fun seedSandboxIdentity(identity: PhoneIdentity, domainId: String?) {
	if (identity.blob() == null) identity.saveBlob(SANDBOX_PROVISIONING)
	domainId?.let { identity.learnDomainId(it, SANDBOX_PROVISIONING) }
}

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

	override fun seedSandbox(
		teams: List<Team>,
		threads: Map<String, List<Message>>,
		dirs: Map<String, List<String>>,
		drafts: Map<String, Draft>,
		goals: Map<String, PendingGoal>,
		gateways: GatewayRegistry,
	) {
		if (!isSandbox) return
		repo.homeGatewayId = sandboxHomeGateway(teams.firstOrNull()?.name, repo.homeGatewayId)
		seedSandboxIdentity(repo.identity, teams.firstOrNull()?.domainId)
		this.dirs = dirs
		repo._state.update { s ->
			s.copy(
				teams = teams,
				threads = threads,
				openTabs = threads.keys.toList(),
				unread = threads.mapValues { (team, msgs) -> unreadCount(msgs, s.readAnchors[team]) },
				connected = true,
				provisioned = true,
				status = "",
				error = null,
				drafts = drafts,
				goals = goals,
				gateways = gateways,
				homeGatewayId = repo.homeGatewayId,
				owner = teams.firstOrNull()?.domainId?.let { OwnerFacts(it, null, false) },
			)
		}
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
			)
		}
	}
}
