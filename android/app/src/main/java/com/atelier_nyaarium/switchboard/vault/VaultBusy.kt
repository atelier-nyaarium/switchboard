package com.atelier_nyaarium.switchboard.vault

internal suspend fun <T> withBusyState(setBusy: (Boolean) -> Unit, work: suspend () -> T): T {
	setBusy(true)
	return try {
		work()
	} finally {
		setBusy(false)
	}
}
