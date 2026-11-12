package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionDockTest {
	@Test
	fun aLimitOutranksCompactingAndNeitherShowsNothing() {
		assertEquals(SessionDock.LIMIT, sessionDock(limitBlocked = true, compacting = true))
		assertEquals(SessionDock.COMPACTING, sessionDock(limitBlocked = false, compacting = true))
		assertEquals(null, sessionDock(limitBlocked = false, compacting = false))
	}

	@Test
	fun startingShowsOnlyUnderNothingElse() {
		assertEquals(SessionDock.STARTING, sessionDock(limitBlocked = false, compacting = false, starting = true))
		assertEquals(SessionDock.COMPACTING, sessionDock(limitBlocked = false, compacting = true, starting = true))
		assertEquals(SessionDock.LIMIT, sessionDock(limitBlocked = true, compacting = false, starting = true))
	}
}
