package com.atelier_nyaarium.switchboard

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The app lock's answer, held for the process so the Activity and the assistant panel read one.
 * A rotation keeps it; `MainActivity` finishing gives it back.
 */
internal object AppLock {
	private val _unlocked = MutableStateFlow(false)
	val unlocked: StateFlow<Boolean> = _unlocked
	private val relocks = AtomicInteger(0)

	private val _fault = MutableStateFlow(false)

	/** The last unlock could not ask. */
	val fault: StateFlow<Boolean> = _fault

	/** Moves at every relock. */
	val epoch: Int get() = relocks.get()

	fun unlock() {
		_fault.value = false
		_unlocked.value = true
	}

	fun relock() {
		relocks.incrementAndGet()
		_fault.value = false
		_unlocked.value = false
	}

	/** An unlock prompt's answer; a fault keeps it locked. */
	fun answered(answer: OwnerPrompt) {
		_fault.value = answer == OwnerPrompt.COULD_NOT_ASK
		if (passes(answer)) unlock()
	}
}

/** Whether the app lock asks before anything shows. */
internal fun appLockAsks(state: ChatState, unlocked: Boolean): Boolean = state.provisioned && state.biometricLock && !unlocked
