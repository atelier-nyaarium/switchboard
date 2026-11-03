package com.atelier_nyaarium.switchboard

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager

internal enum class PhoneLocation { NOT_GRANTED, OFF, ON }

/** WiFi scans need precise. */
internal const val PRECISE_LOCATION = Manifest.permission.ACCESS_FINE_LOCATION

internal fun phoneLocation(context: Context): PhoneLocation = runIsolated {
	when {
		context.checkSelfPermission(PRECISE_LOCATION) != PackageManager.PERMISSION_GRANTED ->
			PhoneLocation.NOT_GRANTED
		context.getSystemService(LocationManager::class.java)?.isLocationEnabled != true -> PhoneLocation.OFF
		else -> PhoneLocation.ON
	}
}.getOrDefault(PhoneLocation.NOT_GRANTED)
