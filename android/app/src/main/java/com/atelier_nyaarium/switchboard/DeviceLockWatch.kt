package com.atelier_nyaarium.switchboard

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** No lock listener; poll while assistant speech matters. */
internal class DeviceLockWatch(
	private val context: Context,
	private val scope: CoroutineScope,
	private val matters: () -> Boolean,
	private val onLocked: () -> Unit,
) {
	private val keyguard = context.getSystemService(KeyguardManager::class.java)
	private var watch: Job? = null

	/** Smart Lock is unlocked. */
	fun locked(): Boolean = runIsolated { keyguard?.isDeviceLocked == true }.getOrDefault(false)

	private val receiver = object : BroadcastReceiver() {
		override fun onReceive(context: Context, intent: Intent) {
			when (intent.action) {
				Intent.ACTION_SCREEN_OFF -> start()
				else -> stop()
			}
		}
	}

	fun register() {
		val filter = IntentFilter().apply {
			addAction(Intent.ACTION_SCREEN_OFF)
			addAction(Intent.ACTION_SCREEN_ON)
			addAction(Intent.ACTION_USER_PRESENT)
		}
		context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
		// Registration may follow screen-off.
		if (context.getSystemService(PowerManager::class.java)?.isInteractive == false) start()
	}

	fun unregister() {
		stop()
		runIsolated { context.unregisterReceiver(receiver) }
	}

	private fun check() {
		if (matters() && locked()) onLocked()
	}

	private fun start() {
		watch?.cancel()
		watch = scope.launch {
			while (isActive) {
				check()
				delay(CHECK_MS)
			}
		}
	}

	/** Check once on stop. */
	private fun stop() {
		watch?.cancel()
		watch = null
		check()
	}

	private companion object {
		const val CHECK_MS = 1_000L
	}
}
