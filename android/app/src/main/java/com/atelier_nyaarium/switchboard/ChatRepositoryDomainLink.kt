package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONObject

// This device's Domain link.

/** Report plugin changes. */
suspend fun ChatRepository.reportEnabledPlugins() = withContext(Dispatchers.IO) {
	pluginReportPending = true
	if (!_state.value.router.settled) return@withContext
	runCatchingCancellable { reportCapabilitiesToRouter() }
		.onSuccess { pluginReportPending = false }
		.onFailure { DebugLog.log("Plugins", "capability report failed, retrying: ${it.message?.take(120)}") }
	Unit
}

/** Report once to the Router. */
internal suspend fun ChatRepository.reportCapabilitiesToRouter() {
	val plugins = enabledPlugins?.invoke() ?: return
	val op = composeCapabilitiesReport(plugins)
	val signed = ownerOps.sign(op) ?: error("cannot sign capabilities report")
	runCatchingCancellable { client().postOwnerOp(signed) }
		.onFailure { DebugLog.log("Plugins", "capability report failed, retrying next toggle: ${it.message?.take(80)}") }
}

/** Null on success; else the reason. */
suspend fun ChatRepository.provision(blob: String): String? = withContext(Dispatchers.IO) {
	// Reject malformed blobs before persisting.
	val prov = try {
		ConsoleCredentials.parse(blob, store)
	} catch (e: Exception) {
		e.rethrowIfCancellation()
		DebugLog.log("Provision", "setup code refused: ${e.message?.take(160)}")
		return@withContext Line.SETUP_CODE_UNREADABLE.text
	}
	assistantOps.forgetHome {
		identity.provision(blob)
		linkChanged()
	}
	sttsClient = null
	// Mirror the reset in UI state.
	_state.update {
		it.copy(provisioned = true, deviceName = prov.device, firstRooted = false, teams = emptyList())
	}
	null
}

/** Normalize a SHA-256 leaf fingerprint. */
internal fun normalizeCertFp(raw: String): String? {
	val stripped = raw.trim().filterNot { it == ':' || it == ' ' || it == '-' }.lowercase()
	if (stripped.length != 64 || !stripped.all { it.isDigit() || it in 'a'..'f' }) return null
	return stripped
}

/** Display-only Router endpoint fields. */
// Credentials never reach the screen.
data class RouterEndpoint(val host: String, val port: Int, val certFp: String, val direct: Boolean)

internal fun parseRouterUrl(url: String, fallbackPort: Int): Pair<String, Int>? {
	val body = url.trim().removeSuffix("/").substringAfter("://", url.trim().removeSuffix("/"))
	if (body.isEmpty()) return null
	val colon = body.lastIndexOf(':')
	if (colon <= 0) return body to fallbackPort
	val port = body.substring(colon + 1).toIntOrNull() ?: return body to fallbackPort
	return body.substring(0, colon) to port
}

/** Current direct Router endpoint. */
fun ChatRepository.currentRouterEndpoint(fallbackPort: Int): RouterEndpoint? {
	val blob = store.load() ?: return null
	val json = runIsolated { JSONObject(blob) }.getOrNull() ?: return null
	val direct = json.optString("transport") == "direct"
	val url = json.optString("routerUrl")
	if (url.isEmpty()) return null
	val (host, port) = parseRouterUrl(url, fallbackPort) ?: return null
	return RouterEndpoint(host, port, json.optString("routerCertFp"), direct)
}

/** Change transport fields only. Null on success; else the reason. */
suspend fun ChatRepository.setEndpoint(host: String, port: Int, certFp: String): String? = withContext(Dispatchers.IO) {
	// Allow endpoint setup before provisioning.
	val blob = store.load() ?: "{}"
	val trimmedHost = host.trim().removeSuffix("/")
	if (trimmedHost.isEmpty()) return@withContext Line.ENTER_HOST.text
	val fp = normalizeCertFp(certFp) ?: return@withContext Line.BAD_FINGERPRINT.text
	val url = if (trimmedHost.startsWith("http")) "$trimmedHost:$port" else "https://$trimmedHost:$port"
	val edited = JSONObject(blob).apply {
		put("transport", "direct")
		put("routerUrl", url)
		put("routerCertFp", fp)
	}.toString()
	try {
		ConsoleCredentials.parse(edited, store)
	} catch (e: Exception) {
		e.rethrowIfCancellation()
		DebugLog.log("Provision", "endpoint refused: ${e.message?.take(160)}")
		return@withContext Line.BAD_ENDPOINT.text
	}
	identity.saveBlob(edited)
	linkChanged()
	sttsClient = null
	null
}

/** This device's blob changed or went: its client is dropped and setup starts over. */
internal fun ChatRepository.linkChanged() {
	invalidateClient()
	setup.startOver()
	if (isSandbox) sandboxSeeder.drawLink()
}

/** Router name, then stored name, then Domain id. */
fun ChatRepository.displayName(): String =
	state.value.owner?.displayName ?: store.displayName.ifEmpty { readyOrNull()?.domainId.orEmpty() }

/** Router-stated admin Domain. */
fun ChatRepository.isAdmin(): Boolean = _state.value.owner?.isAdminDomain == true

/** True only for non-admin owner Domains. */
fun ChatRepository.canDeleteOwnDomain(): Boolean {
	val held = _state.value
	val owner = held.owner ?: return false
	return held.gateways.current && !owner.isAdminDomain && owner.domainId == readyOrNull()?.domainId
}

suspend fun ChatRepository.setDeviceName(name: String) = withContext(Dispatchers.IO) {
	val blob = store.load() ?: return@withContext
	val updated = runCatchingCancellable { JSONObject(blob).put("device", name).toString() }
		.getOrElse { e ->
			_state.update { it.withNotice(Line.RENAME_DEVICE_FAILED.text) }
			return@withContext
		}
	identity.saveBlob(updated)
	linkChanged()
	_state.update { it.copy(deviceName = name) }
}

internal fun ChatRepository.currentDeviceName(): String =
	store.load()?.let { runIsolated { ConsoleCredentials.parse(it, store).device }.getOrNull() } ?: ""

// Never cancelled part way, and one at a time: a wipe cut short would move the term over a phone half wiped.
suspend fun ChatRepository.clearAll() = withContext(Dispatchers.IO + NonCancellable) {
	wipes.withLock {
		// Closed first: nothing lands from here to the end of the wipe.
		provision.advance()
		try {
			// Join poll loop.
			drain.stopAndJoin()
			// Keep voice settings.
			assistantOps.forgetHome { identity.clear() }
			// Wipe durable state.
			for (cache in clearedOnReprovision) cache.clearInMemory()
			stts.purgeAll()
			// Purge attachment files.
			Attachments.purgeAll(filesDir)
			_state.update { ChatState(provisioned = false) }
			onWiped?.let { wiped -> withContext(Dispatchers.Main) { wiped() } }
			// Again: a write still out when the identity went may have put a key back.
			identity.clear()
		} finally {
			provision.settle()
		}
	}
	linkChanged()
}
