package com.atelier_nyaarium.switchboard

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
}
