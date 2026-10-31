package com.atelier_nyaarium.switchboard

import android.util.Log

internal enum class CapabilityLogEvent { QUEUED, STARTED, ANSWERED, REPLAYED, DENIED, FAILED, IGNORED }

internal object CapabilityLog {
	fun record(key: String, event: CapabilityLogEvent, count: Int = 0, accepted: Boolean = true) {
		Log.i("PhoneCapability", "key=$key event=$event count=$count accepted=$accepted")
	}
}
