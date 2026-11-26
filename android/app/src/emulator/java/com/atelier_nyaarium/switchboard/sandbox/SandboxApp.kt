package com.atelier_nyaarium.switchboard.sandbox

import android.app.Application
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.plugins.designer.DesignStore
import com.atelier_nyaarium.switchboard.sandboxRegistry
import com.atelier_nyaarium.switchboard.plugins.designer.storedCardFrom
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAKEOVER_AFTER_MS = 20_000L
private const val TAKEOVER_TAIL = "hold tailscale"

/**
 * The `emulator` build type's entry point.
 *
 * EVERYTHING IN THIS SOURCE SET IS SCAFFOLDING, NOT A SPEC. Add a thread shape, delete a fixture,
 * or bend the canned state to whatever is being looked at this week. None of it is load-bearing and
 * none of it needs to stay consistent with anything. If a fixture stops being useful, remove it
 * rather than maintaining it.
 *
 * What this build is for: looking at the console without a Gateway, an owner key, an admission, or a
 * network. The real app cannot get past onboarding without all four, which meant every visual
 * question had to be answered by the owner on their phone. A CSS variable that was never defined
 * made every reference link in every message render as plain prose, and no test on either side of
 * the wire could see it. That is the class of bug this exists to catch.
 *
 * Nothing here is compiled into debug or release: this source set only belongs to the `emulator`
 * build type. The shared code it needs lives in `SandboxSeeder.kt` and is compiled into every
 * variant, so each piece of it stands behind `isSandbox`.
 */
class SandboxApp : Application() {
	override fun onCreate() {
		super.onCreate()
		// The whole playback half of Voice & TTS is hidden until a key is present, so without one the
		// screen this build exists to look at does not render at all. The key is a placeholder and
		// nothing here can reach a real service; synthesis fails, which is fine for looking at layout.
		AppStateStore(this).let { store ->
			if (store.sttsKey.isEmpty()) store.sttsKey = "sandbox-placeholder-key"
		}

		val fixtures = SandboxFixtures(filesDir, assets)
		// BEFORE the repository exists. BoardManager reads its durable blob once at construction and
		// never re-reads, so a board seeded afterwards is written to disk and then ignored.
		fixtures.seedBoard(AppStateStore(this))
		fixtures.seedRunbooks(AppStateStore(this))
		val repo = Repo.get(this)
		val threads = fixtures.threads()
		val gateways = fixtures.roster()
		repo.seedSandbox(
			fixtures.teams(),
			threads,
			fixtures.dirs(),
			fixtures.drafts(),
			fixtures.goals(),
			sandboxRegistry(gateways, System.currentTimeMillis()),
		)
		// Distinct allowlists, so every binding line shows.
		repo.seedSandboxVault(
			listOf(
				// Unlisted Gateways hold no value.
				com.atelier_nyaarium.switchboard.vault.VaultDraft(id = "deploy-key", publicTitle = "Deploy key", value = "hunter2", gateways = gateways),
				com.atelier_nyaarium.switchboard.vault.VaultDraft(
					id = "elsewhere-key",
					publicTitle = "Elsewhere key",
					value = "k3y",
					gateways = gateways.drop(1).ifEmpty { listOf("elsewhere") },
				),
				com.atelier_nyaarium.switchboard.vault.VaultDraft(id = "a-note", publicTitle = "A note, no value"),
				com.atelier_nyaarium.switchboard.vault.VaultDraft(
					id = "sakura-nyaarium",
					privateTitle = "Sakura Nyaarium",
					value = "hunter3",
					gateways = gateways.take(1),
				),
				// Ties favor answering secrets.
				com.atelier_nyaarium.switchboard.vault.VaultDraft(
					id = "setfacl-twin",
					publicTitle = "Another sudo secret",
					value = "hunter3",
					gateways = gateways.take(1),
				),
			),
		)
		fixtures.teams().firstOrNull()?.let { session -> seedSudoRequests(repo, session.name, gateways.first()) }
		// Notification send card.
		val domain = fixtures.teams().firstOrNull()?.domainId ?: "home"
		gateways.firstOrNull()?.let { gatewayId ->
			repo.assistantSendOps.onRequest(
				gatewayId,
				"host.assistant",
				com.atelier_nyaarium.switchboard.proto.AssistantSendRequest(
					v = 1L,
					requestId = "sandbox-send",
					sessionTarget = "host.assistant",
					deadlineAt = System.currentTimeMillis() + 20 * 3_600_000L,
					intent = com.atelier_nyaarium.switchboard.proto.AssistantSendIntent(
						target = "$domain.$gatewayId.host.worker",
						body = "Could you check whether the release notes mention the schema change?\n\nThe owner asked this morning.",
						disposition = "asking",
						createsSession = false,
						files = listOf(
							com.atelier_nyaarium.switchboard.proto.AssistantSendFile(
								digest = "sha256-${"0".repeat(64)}",
								filename = "notes.md",
								mime = "text/markdown",
								size = 2_048L,
							),
						),
					),
				),
			)
		}
		// Seeding writes rows straight into state, bypassing the mailbox drain where the inbound
		// handlers run, so the dock would stay empty however correct the ingest is. Run the same
		// wire-declared conversion the handler runs, so the gallery is inspectable here.
		for ((team, rows) in threads) {
			for (row in rows) {
				for (file in row.files) storedCardFrom(file, row.at)?.let { DesignStore.upsert(team, it) }
			}
		}
	}

	/** The sudo card's three frames: suggested, open pick, nothing fits. */
	private fun seedSudoRequests(repo: com.atelier_nyaarium.switchboard.ChatRepository, session: String, gateway: String) {
		val now = System.currentTimeMillis()
		val key = "sudo apt-mark"
		val sudo = com.atelier_nyaarium.switchboard.proto.PolicyRef("sakura-sudo", 2L)
		val answering = listOf(com.atelier_nyaarium.switchboard.proto.VaultAnswering("sakura-nyaarium", sudo))
		fun typed(
			id: String,
			why: com.atelier_nyaarium.switchboard.proto.VaultTypedWhy? = com.atelier_nyaarium.switchboard.proto.VaultTypedWhy(code = "no_policy"),
			answering: List<com.atelier_nyaarium.switchboard.proto.VaultAnswering>? = null,
			shape: String = key,
			runsAnything: Boolean? = null,
			cannotRemember: Boolean? = null,
			tail: String = "hold containerd.io docker-ce docker-ce-cli",
		) = com.atelier_nyaarium.switchboard.proto.VaultRequest.Typed(
			v = 1L,
			requestId = id,
			operation = "/usr/bin/$shape $tail",
			displayShape = shape,
			coveredShapes = listOf(shape),
			sessionTarget = "host.demo",
			deadlineAt = now + 19 * 3_600_000L,
			why = why,
			runsAnything = runsAnything,
			answering = answering,
			cannotRemember = cannotRemember,
		)
		val requests = listOf(
			typed("sandbox-sudo-suggested", answering = answering),
			typed("sandbox-sudo-open", tail = "unhold docker-ce"),
			typed(
				"sandbox-sudo-off",
				com.atelier_nyaarium.switchboard.proto.VaultTypedWhy(code = "policy_off", policyId = "old", policyName = "Sakura Old"),
				tail = "showhold",
			),
			typed(
				"sandbox-sudo-unusable",
				com.atelier_nyaarium.switchboard.proto.VaultTypedWhy(
					code = "binding_unusable",
					policyId = "sakura-sudo",
					policyName = "Sakura Sudo",
					entryId = "gone-key",
					unusable = "missing",
				),
				tail = "hold nvidia-driver-560",
			),
			typed("sandbox-sudo-bash", shape = "sudo bash", runsAnything = true, tail = "-c 'apt-get update'"),
			typed("sandbox-sudo-unrememberable", cannotRemember = true, tail = "auto libssl3"),
			typed("sandbox-sudo-older", why = null, tail = "manual curl"),
			typed("sandbox-sudo-refused", answering = answering, tail = "hold linux-image-generic"),
			typed("sandbox-sudo-takeover", answering = answering, tail = TAKEOVER_TAIL),
		)
		for (request in requests) repo.vaultOps.onRequest(session, request)
		repo.vaultOps.onRequest(
			"${session.substringBefore('.')}.unlisted.host.worker",
			typed("sandbox-sudo-none", tail = "hold grub-pc"),
		)
		// A policy comes to cover it.
		CoroutineScope(Dispatchers.Main + CoroutineExceptionHandler { _, _ -> }).launch {
			delay(TAKEOVER_AFTER_MS)
			repo.vaultOps.onRequest(
				session,
				com.atelier_nyaarium.switchboard.proto.VaultRequest.Entry(
					entryId = "sakura-nyaarium",
					v = 1L,
					requestId = "sandbox-sudo-taken",
					operation = "/usr/bin/$key $TAKEOVER_TAIL",
					displayShape = key,
					coveredShapes = listOf(key),
					sessionTarget = "host.demo",
					deadlineAt = now + 19 * 3_600_000L,
					policy = sudo,
					replaces = "sandbox-sudo-takeover",
				),
			)
		}
		repo.vault.setGrants(
			gateway,
			listOf(
				com.atelier_nyaarium.switchboard.proto.VaultGrant.Window(
					grantId = "sandbox-window",
					entryId = "sakura-nyaarium",
					holder = com.atelier_nyaarium.switchboard.proto.VaultHolder.Session("host.demo"),
					displayShape = "sudo setfacl",
					coveredShapes = listOf("sudo setfacl"),
					expiresAt = now + 30 * 60_000L,
					policy = sudo,
				),
			),
		)
	}

}
