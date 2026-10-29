package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The app lock's answer, held for the process so the Activity and the assistant panel read one.
 * A rotation keeps it; `MainActivity` finishing gives it back.
 */
internal object AppLock {
	private val _unlocked = MutableStateFlow(false)
	val unlocked: StateFlow<Boolean> = _unlocked

	fun unlock() {
		_unlocked.value = true
	}

	fun relock() {
		_unlocked.value = false
	}
}

/** Whether the app lock asks before anything shows. */
internal fun appLockAsks(state: ChatState, unlocked: Boolean): Boolean = state.provisioned && state.biometricLock && !unlocked
