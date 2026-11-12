package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which host spawn points the create dialog offers, and how they are labelled.
 *
 * The labelling half matters as much as the list: `host` is an address segment keying session
 * records, resume state, phone threads and board work, so it can never be renamed on the wire. "WSL"
 * exists only in the picker, and only where it is true.
 */
class HostSpawnChoicesTest {
	// An affirmative "nothing beyond host" offers the machine's own shell; no projection offers nothing.
	@Test
	fun `an empty advertisement yields exactly host and no projection yields nothing`() {
		assertEquals(listOf("host"), hostSpawnChoices(emptyList()))
		assertEquals(emptyList<String>(), hostSpawnChoices(GatewayRegistry().hostSpawns("mikan")))
		assertEquals(emptyList<String>(), hostSpawnChoices(testRegistry("mikan").hostSpawns("mikan")))
	}

	@Test
	fun `windows is offered before host`() {
		assertEquals(listOf("windows", "host"), hostSpawnChoices(listOf("windows")))
	}

	// Another machine's answer must not leak into this Gateway's picker: spawning is per machine.
	@Test
	fun `another gateway's advertisement is ignored`() {
		val registry = testRegistry("sakura", "mikan")
			.withEntry("sakura") { it.copy(hostSpawns = listOf("windows")) }
			.withEntry("mikan") { it.copy(hostSpawns = emptyList()) }
		assertEquals(listOf("host"), hostSpawnChoices(registry.hostSpawns("mikan")))
	}

	@Test
	fun `an unknown spawn id is dropped rather than offered`() {
		assertEquals(listOf("host"), hostSpawnChoices(listOf("plan9")))
	}

	@Test
	fun `host is never duplicated even if advertised`() {
		assertEquals(listOf("host"), hostSpawnChoices(listOf("host")))
	}
}

/** Which (gateway, project) a spawn target names. */
class SpawnTargetKeyTest {
	@Test
	fun `a qualified spawn point names its own gateway`() {
		assertEquals("mikan" to "windows", spawnTargetKey("alice.mikan.windows"))
		assertEquals("mikan" to "host", spawnTargetKey("alice.mikan.host"))
	}

	// A bare project names no Gateway, and a session address names a session, not a spawn point.
	@Test
	fun `a bare or unparseable target is not remembered`() {
		assertEquals(null, spawnTargetKey("recipe-app"))
		assertEquals(null, spawnTargetKey("alice.mikan.windows.f7a906"))
		assertEquals(null, spawnTargetKey(""))
		assertEquals(null, spawnTargetKey("   "))
	}
}

class HostSpawnLabelTest {
	// On a Linux machine `host` is just the host. Calling it WSL there would be a lie.
	@Test
	fun `host keeps its name when no windows peer exists`() {
		assertEquals("host", hostSpawnLabel("host", listOf("host", "recipe-app")))
	}

	@Test
	fun `host reads as WSL only alongside windows`() {
		assertEquals("WSL", hostSpawnLabel("host", listOf("windows", "host")))
	}

	@Test
	fun `windows is titled`() {
		assertEquals("Windows", hostSpawnLabel("windows", listOf("windows", "host")))
	}

	// A devcontainer project is shown as itself; only host spawn points are relabelled.
	@Test
	fun `a catalog project is untouched`() {
		assertEquals("recipe-app", hostSpawnLabel("recipe-app", listOf("windows", "host", "recipe-app")))
	}

	/**
	 * The label a Windows machine's host row must carry.
	 *
	 * Pinned because the closed field and the open menu once disagreed: the menu rows went through
	 * this function while the field rendered the raw wire word, so the same thing read "WSL" in the
	 * list and "host" in the box above it depending on whether the menu was open. Caught from a
	 * screenshot rather than a test.
	 *
	 * This asserts the VALUE only. That both surfaces call this one function is a structural fact a
	 * unit test cannot see; what keeps them together is that neither spells a label of its own.
	 */
	@Test
	fun `a windows machine's host row is WSL`() {
		assertEquals("WSL", hostSpawnLabel("host", listOf("windows", "host", "recipe-app")))
	}
}
