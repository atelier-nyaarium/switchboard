package com.atelier_nyaarium.switchboard

import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class SelfMigrationTest {
	@Test
	fun newEpochResetsAcceptedRecordsAndWritesMarker() = runBlocking {
		val journal = MutationJournal(Files.createTempDirectory("migration").toFile())
		var reset = 0
		val migration = SelfMigration(
			readAnchors = { emptyMap() },
			journal = journal,
			reportRead = { _, _ -> buildJsonObject { put("outcome", "accepted") } },
			resetAccepted = { reset++ },
		)
		migration.run(4)
		migration.run(4)
		assertEquals(1, reset)
		assertEquals(1, journal.entries("self_migration").size)
	}
}
