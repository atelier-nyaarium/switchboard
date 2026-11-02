package com.atelier_nyaarium.switchboard

import android.provider.AlarmClock
import java.net.URLEncoder

internal data class AppCandidate(val label: String, val packageName: String)

internal sealed interface AppResolution {
	data class One(val packageName: String) : AppResolution
	data class Several(val candidates: List<AppCandidate>) : AppResolution
	data object None : AppResolution
}

internal sealed interface LaunchExtra {
	val key: String

	data class IntExtra(override val key: String, val value: Int) : LaunchExtra
	data class TextExtra(override val key: String, val value: String) : LaunchExtra
	data class FlagExtra(override val key: String, val value: Boolean) : LaunchExtra
}

internal fun mapsUri(query: String, navigate: Boolean): String {
	val encoded = URLEncoder.encode(query.trim().take(200), "UTF-8").replace("+", "%20")
	return if (navigate) "google.navigation:q=$encoded" else "geo:0,0?q=$encoded"
}

internal fun resolveApp(candidates: List<AppCandidate>, query: String): AppResolution {
	if (query.isBlank()) return AppResolution.None
	val matches = candidates.distinctBy { it.packageName }.filter { appMatches(it.label, it.packageName, query) }
	return when (matches.size) {
		0 -> AppResolution.None
		1 -> AppResolution.One(matches.single().packageName)
		else -> AppResolution.Several(matches.take(10).map { AppCandidate(it.label.take(80), it.packageName.take(120)) })
	}
}

internal fun alarmExtras(hour: Long, minutes: Long, message: String?): List<LaunchExtra> = buildList {
	add(LaunchExtra.IntExtra(AlarmClock.EXTRA_HOUR, hour.coerceIn(0L, 23L).toInt()))
	add(LaunchExtra.IntExtra(AlarmClock.EXTRA_MINUTES, minutes.coerceIn(0L, 59L).toInt()))
	message?.take(80)?.let { add(LaunchExtra.TextExtra(AlarmClock.EXTRA_MESSAGE, it)) }
	add(LaunchExtra.FlagExtra(AlarmClock.EXTRA_SKIP_UI, true))
}

internal fun timerExtras(seconds: Long, message: String?): List<LaunchExtra> = buildList {
	add(LaunchExtra.IntExtra(AlarmClock.EXTRA_LENGTH, seconds.coerceIn(1L, 86_400L).toInt()))
	message?.take(80)?.let { add(LaunchExtra.TextExtra(AlarmClock.EXTRA_MESSAGE, it)) }
	add(LaunchExtra.FlagExtra(AlarmClock.EXTRA_SKIP_UI, true))
}
