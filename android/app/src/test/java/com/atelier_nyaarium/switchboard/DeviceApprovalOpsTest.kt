package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DeviceApprovalOpsTest {
	@Test
	fun parsesThePublicApprovalEnvelope() = runBlocking {
		val store = testStore()
		val ops = DeviceApprovalOps(
			MutableStateFlow(ChatState()),
			store,
			TestIdentityPort(store),
			FailingClientPort,
			TestDeviceCollaborators(),
		)
		val scan = ops.parseAuthorizeConsole(
			"""{"type":"authorize-console","domainId":"domain","signPub":"owner","boxPub":"box","approvalId":"approval","nonce":"nonce","reach":"https://router"}""",
		)

		assertEquals("domain", scan?.domainId)
		assertEquals("approval", scan?.approvalId)
	}

	@Test
	fun aJoinBundleFromABuildThatCarriedAHomeGatewayIsRefused() {
		val current = parseConsoleTransport("""{"version":2,"appToken":"token","domainId":"domain"}""")
		assertEquals("domain", current.domainId)

		val refused = assertThrows(IllegalArgumentException::class.java) {
			parseConsoleTransport("""{"appToken":"token","domainId":"domain","gatewayId":"sakura"}""")
		}
		assertEquals("The held device runs an older build; update it and approve again.", refused.message)
	}

	private class TestDeviceCollaborators : DeviceApprovalOpsCollaborators {
		override fun approvalNonces() = mutableMapOf<String, String>()
		override fun installApprovedDevice(
			blob: String,
			domainJson: String?,
			domainVersion: String?,
			contentKeys: Map<Int, ByteArray>,
			domainId: String?,
		) = true
		override fun invalidateClients() = Unit
		override suspend fun submitOwnerAdmission(signed: SignedAdmission) = true
		override fun reportError() = null
	}
}
