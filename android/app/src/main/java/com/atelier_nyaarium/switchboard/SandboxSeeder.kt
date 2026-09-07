package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update

/** No Gateway, no Router, no network. */
internal val isSandbox: Boolean get() = BuildConfig.BUILD_TYPE == "emulator"

internal const val SANDBOX_UNREACHABLE = "no Gateway in the sandbox"

internal fun sandboxHomeGateway(firstTeam: String?, current: String): String =
	firstTeam?.split(".")?.getOrNull(1) ?: current

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
		admittedGateways: List<String> = emptyList(),
	)
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
		admittedGateways: List<String>,
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
				admittedGateways = admittedGateways,
				homeGatewayId = repo.homeGatewayId,
			)
		}
	}
}
