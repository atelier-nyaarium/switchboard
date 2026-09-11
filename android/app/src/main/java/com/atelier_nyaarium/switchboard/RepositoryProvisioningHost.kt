package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.board.BoardSealing
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

internal interface RepositoryProvisioningHost {
	fun transport(): ConsoleRouterTransport
	fun client(): ConsoleClient
	/** The held client, without building one. */
	fun clientOrNull(): ConsoleClient?
	fun invalidateClient()
	fun applyDomainSync(snapshot: DomainSnapshot, version: String)
	fun localDomain(): String
	fun boardSealing(): BoardSealing?
	fun vaultSealing(): VaultSealing?
}

internal class ChatRepositoryProvisioningHost(private val repo: ChatRepository) : RepositoryProvisioningHost {
	@Volatile private var clientBoot: PhoneBootstrap? = null
	@Volatile private var cachedTransport: ConsoleRouterTransport? = null
	@Volatile private var held: ConsoleClient? = null

	override fun clientOrNull(): ConsoleClient? = held

	override fun invalidateClient() {
		held = null
		clientBoot = null
		cachedTransport = null
	}

	override fun transport(): ConsoleRouterTransport {
		cachedTransport?.let { return it }
		val blob = repo.store.load() ?: error("not provisioned")
		return ConsoleRouterTransport(ConsoleCredentials.parse(blob, repo.store), repo.store, repo.identity::saveBlob).also {
			cachedTransport = it
		}
	}

	override fun client(): ConsoleClient {
		val boot = repo.readyOrNull() ?: error("Domain not yet confirmed")
		if (clientBoot === boot) held?.let { return it }
		return ConsoleClient(
			boot,
			repo.ambient,
			repo.store,
			coordinator = repo.transportCoordinator,
			collaborators = ConsoleClientCollaborators(
				signOwnerOp = { op, opId -> repo.ownerOpsOrNull()?.sign(op, opId) },
				saveProvisioning = repo.identity::saveBlob,
			),
		).also {
			clientBoot = boot
			held = it
		}
	}

	override fun applyDomainSync(snapshot: DomainSnapshot, version: String) {
		repo.identity.applyDomainSync(snapshot, version)
		invalidateClient()
	}

	override fun localDomain(): String = repo.readyOrNull()?.domainId.orEmpty()

	override fun boardSealing(): BoardSealing? {
		val boot = repo.readyOrNull() ?: return null
		return BoardSealing(boot, repo.ambient) { epoch ->
			repo.repoScope.launch(Dispatchers.IO) { repo.keyDeliveryOrNull()?.requestMissing(epoch) }
		}
	}

	override fun vaultSealing(): VaultSealing? {
		val boot = repo.readyOrNull() ?: return null
		return VaultSealing(boot, repo.ambient) { epoch ->
			repo.repoScope.launch(Dispatchers.IO) { repo.keyDeliveryOrNull()?.requestMissing(epoch) }
		}
	}
}
