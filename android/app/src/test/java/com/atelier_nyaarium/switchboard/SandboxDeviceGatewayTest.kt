package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxDeviceGatewayTest {
	private fun ops() = DeviceOps(
		object : DeviceHost {
			override val gateway: DeviceGateway = SandboxDeviceGateway(pause = {})
			override val generation = WorkspaceGeneration()
			override fun names(gatewayId: String) = true
		},
	)

	@Test
	fun `the empty Gateway pairs nothing while the home holds a lamp and a silent porch plug`() = runBlocking {
		val ops = ops()
		ops.refresh(EMPTY_GATEWAY)
		assertEquals(DeviceListView.Listed(emptyList(), 1L), ops.view(EMPTY_GATEWAY).list)
		ops.refresh("sandbox")
		val view = ops.view("sandbox")
		val records = (view.list as DeviceListView.Listed).records
		val lamp = records.single { it.name == "Desk lamp" }
		val porch = records.single { it.name == "Porch light" }
		assertEquals(DeviceLive(Protocol.Wire.DeviceState.ON), view.liveOf(lamp.id))
		assertTrue(view.detailRetry(porch.id))
	}

	@Test
	fun `a stale write is refused, and every second scan finds the daemon away`() = runBlocking {
		val ops = ops()
		ops.refresh("sandbox")
		val lamp = (ops.view("sandbox").list as DeviceListView.Listed).records.single { it.name == "Desk lamp" }
		assertTrue(ops.rename("sandbox", lamp, "Reading lamp") is DeviceSaved.Stored)
		assertTrue(ops.remove("sandbox", lamp) is DeviceSaved.Refused)
		ops.scan("sandbox")
		assertTrue(ops.view("sandbox").scan is ScanView.Found)
		ops.scan("sandbox")
		assertTrue(ops.view("sandbox").scan is ScanView.Failed)
	}
}
