package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.VAULT_VALUE_KIND
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The emulator build shows nothing until the boot is Ready, and no gate on this project can see
// its screen. This is the one that reads what the sandbox seeds.
class SandboxIdentityTest {
	private fun identity(): PhoneIdentity = testStore().let { PhoneIdentity(it, FederationManager(it)) }

	@Test
	fun theSandboxSeedsEveryFactABootNeeds() {
		val identity = identity()
		seedSandboxIdentity(identity, "local")
		assertTrue(identity.bootState.value is BootState.Ready)
	}

	@Test
	fun aSecondRunOverSeededStateStillBoots() {
		val identity = identity()
		seedSandboxIdentity(identity, "local")
		seedSandboxIdentity(identity, "local")
		assertTrue(identity.bootState.value is BootState.Ready)
	}

	// A seeded vault value seals to nothing until the epochs exist, and nothing on screen says so.
	@Test
	fun derivingTheEpochsIsWhatLetsTheSandboxSeal() {
		val identity = identity()
		seedSandboxIdentity(identity, "local")
		val boot = identity.readyOrNull()!!
		val sealing = VaultSealing(boot, testAmbient()) {}
		assertNull(sealing.seal("hunter2", VAULT_VALUE_KIND, "deploy-key"))
		identity.ensureContentEpochs(boot)
		assertNotNull(sealing.seal("hunter2", VAULT_VALUE_KIND, "deploy-key"))
	}
}
