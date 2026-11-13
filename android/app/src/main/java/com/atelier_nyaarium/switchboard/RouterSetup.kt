package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

////////////////////////////////
//  Interfaces & Types

/** How one setup step ended. */
internal sealed interface StepResult {
	data object Done : StepResult

	/** Tried again next pass. A null cause means a door noted why. */
	data class Later(val cause: String? = null) : StepResult

	/** The Router said no for good. */
	data class Refused(val cause: String) : StepResult
}

internal interface SetupHost {
	val router: RouterLink

	fun note(event: RouterEvent)

	suspend fun firstRoot(): StepResult
	suspend fun admit(): StepResult

	/** Best effort. */
	fun announce()
	fun settled()

	fun attachIngest()
	fun flushIngest()
}

////////////////////////////////
//  Functions & Helpers

/** A failure on this device, worded for the owner. */
internal fun localCause(e: Throwable): String = when (e) {
	is SecureStorageUnavailable -> "Secure storage unavailable - turn on a screen lock, then retry"
	is IdentityCorrupt -> "Stored key unreadable - restore from backup or re-run setup.sh"
	else -> "Setup failed: ${e.message?.take(100) ?: e.javaClass.simpleName}"
}

/** A step that threw. A null cause means its door told the link why. */
internal fun laterOf(e: Throwable): StepResult.Later = StepResult.Later(
	when {
		e is java.io.IOException -> null
		e is RouterStatus && eventOfStatus(e.code) != RouterEvent.Reached -> null
		else -> localCause(e)
	},
)

/** A failure on this device: a corrupt key waits on the owner, the rest is tried again. */
internal fun localEvent(e: Throwable): RouterEvent =
	if (e is IdentityCorrupt) RouterEvent.SetupRefused(localCause(e)) else RouterEvent.SetupStalled(localCause(e))

////////////////////////////////
//  Classes

/** What this device owes the Router before it is usable, run until none is owed. */
internal class RouterSetup(
	private val identity: PhoneIdentity,
	private val transport: () -> ConsoleReach,
	private val host: SetupHost,
) {
	private val flight = Mutex()
	private val lock = Any()

	/** Bumped when setup starts over, so a run begun before it lands nothing. */
	private var generation = 0

	/** Runs the owed steps; true once none is left. */
	suspend fun settle(): Boolean = flight.withLock {
		if (host.router.setup is Setup.Owed) attempt()
		host.router.setup !is Setup.Owed
	}

	private suspend fun attempt() {
		val run = synchronized(lock) { generation }
		host.attachIngest()
		// Fence learned facts to this blob.
		val blob = identity.blob() ?: return
		try {
			val answered = transport().preflight() as? Preflight.Answered ?: return
			answered.reach?.domainId?.let { identity.learnDomainId(it, blob) }
			if (!landed(run, host.firstRoot()) || !landed(run, host.admit())) return
			identity.readyOrNull()?.let(identity::ensureContentEpochs)
			host.announce()
			host.settled()
			say(run, RouterEvent.SetupSettled)
			DebugLog.log("Setup", "settled domain=${identity.readyOrNull()?.domainId ?: "none"}")
		} catch (e: Exception) {
			e.rethrowIfCancellation()
			DebugLog.log("Setup", "stalled: ${e.javaClass.simpleName}: ${e.message?.take(120)}")
			say(run, localEvent(e))
		} finally {
			host.flushIngest()
		}
	}

	/** This device's blob changed or went. */
	fun startOver() = synchronized(lock) {
		generation++
		host.note(RouterEvent.SetupOwed)
	}

	/** The owner asked again after a refusal. */
	fun retry() {
		if (host.router.setup is Setup.Refused) startOver()
	}

	/** A run's word lands only while setup has not started over since it began. */
	private fun say(run: Int, event: RouterEvent) = synchronized(lock) {
		if (run == generation) host.note(event)
	}

	private fun landed(run: Int, step: StepResult): Boolean = when (step) {
		StepResult.Done -> true
		is StepResult.Later -> {
			step.cause?.let { say(run, RouterEvent.SetupStalled(it)) }
			false
		}
		is StepResult.Refused -> {
			say(run, RouterEvent.SetupRefused(step.cause))
			false
		}
	}
}

internal class ChatRepositorySetupHost(private val repo: ChatRepository) : SetupHost {
	override val router get() = repo._state.value.router

	override fun note(event: RouterEvent) = repo.noteRouter(event)

	override suspend fun firstRoot() = repo.ownerFacts.firstRoot()
	override suspend fun admit() = repo.ownerFacts.admitThisConsole()

	override fun announce() {
		repo.pluginReportPending = false
		repo.repoScope.launch { repo.reportCapabilitiesToRouter() }
	}

	override fun settled() {
		repo._state.update {
			it.copy(teams = with(repo) { it.teams.withoutTombstoned() }, firstRooted = it.firstRooted || repo.store.firstRooted)
		}
	}

	override fun attachIngest() {
		runIsolated {
			repo.store.load()?.let { DebugLog.attachIngest(ConsoleCredentials.parse(it, repo.store)) { repo.client().transport.proxyBase } }
		}
	}

	override fun flushIngest() = DebugLog.flushToIngest()
}
