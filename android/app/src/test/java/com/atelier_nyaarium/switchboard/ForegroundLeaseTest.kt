package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class ForegroundLeaseTest {
	@Test
	fun closingOneHostNeverBackgroundsTheOther() {
		val edges = mutableListOf<String>()
		val lease = ForegroundLease({ edges += "fg" }, { edges += "bg" })

		lease.take(ForegroundHolder.ACTIVITY)
		lease.take(ForegroundHolder.PANEL)
		lease.release(ForegroundHolder.PANEL)
		lease.take(ForegroundHolder.PANEL)
		lease.release(ForegroundHolder.ACTIVITY)
		lease.release(ForegroundHolder.ACTIVITY)
		lease.release(ForegroundHolder.PANEL)

		assertEquals(listOf("fg", "bg"), edges)
	}
}
