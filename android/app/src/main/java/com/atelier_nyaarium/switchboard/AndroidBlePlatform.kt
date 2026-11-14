package com.atelier_nyaarium.switchboard

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.ParcelUuid
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import com.atelier_nyaarium.switchboard.proto.INTEGRATIONS
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

private const val BASE_UUID_TAIL = "-0000-1000-8000-00805f9b34fb"
internal const val RADIO_PASS_MS = 20_000L

private fun hexOf(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

private fun bytesOf(hex: String): ByteArray = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun shortUuid(uuid: ParcelUuid): String {
	val text = uuid.uuid.toString().lowercase()
	return if (text.startsWith("0000") && text.endsWith(BASE_UUID_TAIL)) text.substring(4, 8) else text
}

private fun fullUuid(short: String): ParcelUuid = ParcelUuid.fromString("0000$short$BASE_UUID_TAIL")

internal fun sightingOf(result: ScanResult): Sighting? {
	val record = result.scanRecord ?: return null
	val makers = record.manufacturerSpecificData
	val data = if (makers == null) emptyMap() else (0 until makers.size()).associate { at -> makers.keyAt(at).toString() to hexOf(makers.valueAt(at)) }
	val services = (record.serviceUuids.orEmpty() + record.serviceData.orEmpty().keys).map(::shortUuid).distinct()
	val age = (SystemClock.elapsedRealtimeNanos() - result.timestampNanos) / 1_000_000
	return Sighting(result.device.address.lowercase(), result.rssi, Advert(record.deviceName, data, services), System.currentTimeMillis() - age)
}

private fun familyFilters(): List<ScanFilter> = INTEGRATIONS.mapNotNull { it.bluetooth }.flatMap { match ->
	match.services.map { ScanFilter.Builder().setServiceUuid(fullUuid(it)).build() } +
		match.makerData.map { ScanFilter.Builder().setManufacturerData(it.company.toInt(), bytesOf(it.prefix)).build() }
}

internal class AndroidBlePlatform(private val context: Context) : BlePlatform {
	private val adapter get() = context.getSystemService(BluetoothManager::class.java)?.adapter

	private val scanner: BluetoothLeScanner? get() = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner

	override fun readiness(): RadioReadiness {
		val held = adapter ?: return RadioReadiness.ABSENT
		if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
			return RadioReadiness.NOT_GRANTED
		}
		return if (held.isEnabled) RadioReadiness.READY else RadioReadiness.OFF
	}

	@SuppressLint("MissingPermission")
	override suspend fun scan(windowMs: Long): List<Sighting> {
		if (readiness() != RadioReadiness.READY) return emptyList()
		val radio = scanner ?: return emptyList()
		val heard = ConcurrentHashMap<String, Sighting>()
		val failed = CompletableDeferred<Int>()
		val callback = object : ScanCallback() {
			override fun onScanResult(callbackType: Int, result: ScanResult) {
				val sighting = sightingOf(result) ?: return
				heard.merge(sighting.mac, sighting) { held, fresh -> fresh.copy(signal = maxOf(held.signal, fresh.signal)) }
			}

			override fun onBatchScanResults(results: MutableList<ScanResult>) {
				for (result in results) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result)
			}

			override fun onScanFailed(errorCode: Int) {
				failed.complete(errorCode)
			}
		}
		radio.startScan(familyFilters(), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
		val code = try {
			withTimeoutOrNull(windowMs) { failed.await() }
		} finally {
			runIsolated { radio.stopScan(callback) }
		}
		if (code != null) throw BleScanFailed(code)
		return heard.values.toList()
	}

	private fun pending(): PendingIntent = PendingIntent.getBroadcast(
		context,
		0,
		Intent(context, BleScanReceiver::class.java),
		PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
	)

	@SuppressLint("MissingPermission")
	override fun watch(addresses: Set<String>): Boolean {
		if (readiness() != RadioReadiness.READY) return false
		val radio = scanner ?: return false
		return runIsolated {
			radio.stopScan(pending())
			if (addresses.isEmpty()) return@runIsolated true
			val filters = addresses.map { ScanFilter.Builder().setDeviceAddress(it.uppercase()).build() }
			val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
			radio.startScan(filters, settings, pending()) == 0
		}.getOrDefault(false)
	}
}

/** Receives paired sensor scans. */
class BleScanReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		DebugLog.init(context)
		val results = IntentCompat.getParcelableArrayListExtra(intent, BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT, ScanResult::class.java)
			.orEmpty()
		if (results.isEmpty()) {
			if (intent.hasExtra(BluetoothLeScanner.EXTRA_ERROR_CODE)) Repo.get(context).phoneRadio.scanLost()
			return
		}
		try {
			SwitchboardService.start(context)
		} catch (e: Exception) {
			DebugLog.log("Radio", "scan wake revival refused: $e")
		}
		Repo.get(context).phoneRadio.heard(results.mapNotNull(::sightingOf))
	}
}
