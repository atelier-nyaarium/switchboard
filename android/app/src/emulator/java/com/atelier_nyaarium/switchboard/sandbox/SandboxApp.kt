package com.atelier_nyaarium.switchboard.sandbox

import android.app.Application
import com.atelier_nyaarium.switchboard.AppStateStore
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.plugins.designer.DesignStore
import com.atelier_nyaarium.switchboard.sandboxRegistry
import com.atelier_nyaarium.switchboard.plugins.designer.storedCardFrom

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
				com.atelier_nyaarium.switchboard.vault.VaultDraft(id = "deploy-key", publicTitle = "Deploy key", value = "hunter2"),
				com.atelier_nyaarium.switchboard.vault.VaultDraft(
					id = "elsewhere-key",
					publicTitle = "Elsewhere key",
					value = "k3y",
					gateways = gateways.drop(1).ifEmpty { listOf("elsewhere") },
				),
				com.atelier_nyaarium.switchboard.vault.VaultDraft(id = "a-note", publicTitle = "A note, no value"),
			),
		)
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

}
