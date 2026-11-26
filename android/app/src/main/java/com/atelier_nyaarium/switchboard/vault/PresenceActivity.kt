package com.atelier_nyaarium.switchboard.vault

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.runCatchingCancellable
import com.atelier_nyaarium.switchboard.runIsolated
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * See-through, and only runs the presence gate's prompt, so an approval from the overlay asks over the
 * app in front rather than bringing Switchboard forward. Its own task, kept out of recents.
 */
class PresenceActivity : FragmentActivity() {
	private val token: String? by lazy { intent.getStringExtra(EXTRA_TOKEN) }

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val ask = PresencePrompt.started(token)
		// A recreation counts as a cancel, so one tap never prompts twice.
		if (ask == null || savedInstanceState != null) {
			PresencePrompt.settle(token, Presence.Refused)
			finish()
			return
		}
		// Nothing waits for it any more.
		lifecycleScope.launch {
			ask.abandoned.await()
			finish()
		}
		lifecycleScope.launch {
			val answer = runCatchingCancellable { Repo.get(this@PresenceActivity).vaultOps.ownerPresence(this@PresenceActivity) }
				.getOrDefault(Presence.CouldNotAsk)
			PresencePrompt.settle(token, answer)
			finish()
		}
	}

	override fun onDestroy() {
		// Gone before the gate answered.
		if (isFinishing) PresencePrompt.settle(token, Presence.Refused)
		super.onDestroy()
	}

	internal companion object {
		const val EXTRA_TOKEN = "presence_token"
	}
}

/** The overlay's road to the presence gate, which needs an activity to prompt on. */
internal object PresencePrompt {
	class Ask {
		internal val started = CompletableDeferred<Unit>()
		internal val present = CompletableDeferred<Presence>()
		val abandoned = CompletableDeferred<Unit>()
	}

	private const val START_WAIT_MS = 5_000L
	private val asks = ConcurrentHashMap<String, Ask>()
	private val next = AtomicLong()

	/** A prompt that never opens could not ask. */
	suspend fun ask(context: Context): Presence {
		val token = next.incrementAndGet().toString()
		val ask = Ask()
		asks[token] = ask
		try {
			val intent = Intent(context, PresenceActivity::class.java)
				.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
				.putExtra(PresenceActivity.EXTRA_TOKEN, token)
			if (runIsolated { context.startActivity(intent) }.isFailure) return Presence.CouldNotAsk
			// A launch the platform blocks fails silently.
			withTimeoutOrNull(START_WAIT_MS) { ask.started.await() } ?: return Presence.CouldNotAsk
			return ask.present.await()
		} finally {
			asks.remove(token)
			ask.abandoned.complete(Unit)
		}
	}

	/** Null when no caller waits on this token. */
	fun started(token: String?): Ask? = token?.let { asks[it] }?.also { it.started.complete(Unit) }

	/** The first answer stands. */
	fun settle(token: String?, answer: Presence) {
		token?.let { asks[it]?.present?.complete(answer) }
	}
}
