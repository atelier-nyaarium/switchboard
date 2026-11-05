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
			PresencePrompt.settle(token, false)
			finish()
			return
		}
		// Nothing waits for it any more.
		lifecycleScope.launch {
			ask.abandoned.await()
			finish()
		}
		lifecycleScope.launch {
			val present = runCatchingCancellable { Repo.get(this@PresenceActivity).vaultOps.ownerPresent(this@PresenceActivity) }
				.getOrDefault(false)
			PresencePrompt.settle(token, present)
			finish()
		}
	}

	override fun onDestroy() {
		// Gone before the gate answered.
		if (isFinishing) PresencePrompt.settle(token, false)
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
		internal val present = CompletableDeferred<Boolean>()
		val abandoned = CompletableDeferred<Unit>()
	}

	private const val START_WAIT_MS = 5_000L
	private val asks = ConcurrentHashMap<String, Ask>()
	private val next = AtomicLong()

	/** False when the owner cancels, fails, or the prompt never opens. */
	suspend fun ask(context: Context): Boolean {
		val token = next.incrementAndGet().toString()
		val ask = Ask()
		asks[token] = ask
		try {
			val intent = Intent(context, PresenceActivity::class.java)
				.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
				.putExtra(PresenceActivity.EXTRA_TOKEN, token)
			if (runIsolated { context.startActivity(intent) }.isFailure) return false
			// A launch the platform blocks fails silently.
			withTimeoutOrNull(START_WAIT_MS) { ask.started.await() } ?: return false
			return ask.present.await()
		} finally {
			asks.remove(token)
			ask.abandoned.complete(Unit)
		}
	}

	/** Null when no caller waits on this token. */
	fun started(token: String?): Ask? = token?.let { asks[it] }?.also { it.started.complete(Unit) }

	fun settle(token: String?, present: Boolean) {
		token?.let { asks[it]?.present?.complete(present) }
	}
}
