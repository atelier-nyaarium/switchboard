package com.atelier_nyaarium.switchboard

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.PatternMatcher
import java.io.DataInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** The phone's WiFi, through Android's network picker. */
internal class AndroidPlugSetupPlatform(private val context: Context) : PlugSetupPlatform {
	private val connectivity get() = context.getSystemService(ConnectivityManager::class.java)
	private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

	override suspend fun join(networkPrefix: String): PlugLink? = suspendCancellableCoroutine { waiting ->
		val specifier = WifiNetworkSpecifier.Builder()
			.setSsidPattern(PatternMatcher(networkPrefix, PatternMatcher.PATTERN_PREFIX))
			.build()
		val request = NetworkRequest.Builder()
			.addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
			.removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
			.setNetworkSpecifier(specifier)
			.build()
		val callback = object : ConnectivityManager.NetworkCallback() {
			override fun onAvailable(network: Network) {
				if (waiting.isActive) waiting.resume(AndroidPlugLink(connectivity, this, network))
			}

			override fun onUnavailable() {
				if (waiting.isActive) waiting.resume(null)
			}
		}
		connectivity.requestNetwork(request, callback, JOIN_TIMEOUT_MS)
		waiting.invokeOnCancellation { runIsolated { connectivity.unregisterNetworkCallback(callback) } }
	}

	override fun memory(): SetupMemory =
		SetupMemory(ssid = prefs.getString(KEY_SSID, null), wifiEntry = prefs.getString(KEY_ENTRY, null))

	override fun remember(memory: SetupMemory) {
		prefs.edit().putString(KEY_SSID, memory.ssid).putString(KEY_ENTRY, memory.wifiEntry).apply()
	}

	private companion object {
		const val PREFS = "plug_setup"
		const val KEY_SSID = "ssid"
		const val KEY_ENTRY = "wifi_entry"
		const val JOIN_TIMEOUT_MS = 120_000
	}
}

private class AndroidPlugLink(
	private val connectivity: ConnectivityManager,
	private val callback: ConnectivityManager.NetworkCallback,
	private val network: Network,
) : PlugLink {
	/** The plug's address on its own network. */
	private val host: InetAddress by lazy {
		connectivity.getLinkProperties(network)?.dhcpServerAddress ?: InetAddress.getByName(SETUP_HOST)
	}

	override suspend fun request(json: String): String = withContext(Dispatchers.IO) {
		network.socketFactory.createSocket().use { socket ->
			socket.soTimeout = ANSWER_TIMEOUT_MS
			socket.connect(InetSocketAddress(host, KASA_PORT), CONNECT_TIMEOUT_MS)
			socket.getOutputStream().apply {
				write(KasaCodec.frame(json))
				flush()
			}
			val input = DataInputStream(socket.getInputStream())
			val length = input.readInt()
			require(length in 0..MAX_ANSWER_BYTES) { "Kasa answer is too large" }
			val body = ByteArray(length)
			input.readFully(body)
			KasaCodec.decrypt(body)
		}
	}

	override fun close() {
		runIsolated { connectivity.unregisterNetworkCallback(callback) }
	}

	private companion object {
		const val SETUP_HOST = "192.168.0.1"
		const val KASA_PORT = 9999
		const val CONNECT_TIMEOUT_MS = 5_000
		const val ANSWER_TIMEOUT_MS = 8_000
		const val MAX_ANSWER_BYTES = 64 * 1024
	}
}
