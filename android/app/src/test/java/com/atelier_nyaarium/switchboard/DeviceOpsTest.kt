package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceAddResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRemoveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRenameResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceScanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSchedulePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSensorThresholdPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSettingPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceLanded
import com.atelier_nyaarium.switchboard.proto.DeviceLiveState
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceRefusal
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceScheduleRule
import com.atelier_nyaarium.switchboard.proto.DeviceSensorThreshold
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.KasaClock
import com.atelier_nyaarium.switchboard.proto.KasaSettingPut
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val GW = "sakura"
private const val LAMP = "aa:bb:cc:dd:ee:01"

private fun record(id: String = LAMP, name: String = "Lamp", revision: Long = 1L) =
	DeviceRecord(id = id, name = name, kind = "switch", driver = "kasa", address = "10.0.0.1", revision = revision)

private fun refusal(code: String, effect: String = "none", detail: String? = null, landed: DeviceLanded? = null, record: DeviceRecord? = null) =
	DeviceRefusal(code = code, effect = effect, detail = detail, landed = landed, record = record)

private const val FREEZER = "aa:bb:cc:dd:ee:11"

private fun sensorRecord(id: String = FREEZER, name: String = "Freezer") =
	DeviceRecord(id = id, name = name, kind = "sensor", driver = "govee", address = id, radio = "gateway", definition = "govee-h5110", revision = 1L)

private fun sensorRead(vararg thresholds: DeviceSensorThreshold) =
	ConsoleDeviceReadResult.Sensor(readings = emptyList(), heardAt = 5L, thresholds = thresholds.toList())

private val schedule = DeviceSchedule(enabled = true, rules = emptyList())
private val settings = DeviceSettings.Kasa(led = true, clock = KasaClock(time = "2026-11-02T18:00:00-08:00", zone = "PST8PDT"), cloud = "bound")
private val evening = DeviceScheduleRule(id = null, days = List(7) { true }, time = "18:00", action = "on", enabled = true)

private fun readOk(state: String) = ConsoleDeviceReadResult.Ok(DeviceLiveState(state, 1L), schedule, settings)

private fun <T> answered(value: T): DeviceAnswer<T> = DeviceAnswer.Answered(value)

class DeviceOpsTest {
	private class FakeGateway : DeviceGateway {
		var held = record()
		var gone = false
		var relay = "off"
		var reachable = true
		var declined = false
		var addAnswer: ConsoleDeviceAddResult? = null
		var listAnswer: ConsoleDeviceListResult? = null
		var readAnswer: ConsoleDeviceReadResult? = null
		var setAnswer: ConsoleDeviceSetResult? = null
		var renameAnswer: ConsoleDeviceRenameResult? = null
		var scanAnswer: ConsoleDeviceScanResult = ConsoleDeviceScanResult.Ok(emptyList())
		val readHolds = ArrayDeque<TestHold>()
		var setHold: TestHold? = null
		var writes = 0
		var sets = 0
		var listCalls = 0
		var readCalls = 0
		var requests = 0

		private fun <T> reply(value: () -> T): DeviceAnswer<T> {
			requests += 1
			return when {
				declined -> DeviceAnswer.Declined
				!reachable -> DeviceAnswer.Unreachable
				else -> answered(value())
			}
		}

		override suspend fun list(gatewayId: String): DeviceAnswer<ConsoleDeviceListResult> {
			listCalls += 1
			return reply { listAnswer ?: ConsoleDeviceListResult.Ok(if (gone) emptyList() else listOf(held), held.revision) }
		}

		override suspend fun read(gatewayId: String, id: String): DeviceAnswer<ConsoleDeviceReadResult> {
			readCalls += 1
			// Captures answer before suspension.
			val answer = reply { readAnswer ?: readOk(relay) }
			readHolds.removeFirstOrNull()?.pass()
			return answer
		}

		override suspend fun scan(gatewayId: String) = reply { scanAnswer }

		override suspend fun homeNetwork(gatewayId: String) =
			reply { com.atelier_nyaarium.switchboard.proto.ConsoleDeviceHomeNetworkResult.Ok(ssid = "Home") }

		override suspend fun add(gatewayId: String, mac: String, address: String, name: String) =
			reply { addAnswer ?: ConsoleDeviceAddResult.Ok(record(mac, name)) }

		override suspend fun rename(gatewayId: String, id: String, name: String, revision: Long) = reply {
			writes += 1
			renameAnswer ?: ConsoleDeviceRenameResult.Ok(record(id, name, revision + 1))
		}

		override suspend fun remove(gatewayId: String, id: String, revision: Long) = reply { ConsoleDeviceRemoveResult.Ok }

		override suspend fun set(gatewayId: String, id: String, verb: String): DeviceAnswer<ConsoleDeviceSetResult> {
			sets += 1
			setHold?.let {
				setHold = null
				it.pass()
			}
			return reply {
				setAnswer ?: run {
					relay = verb
					ConsoleDeviceSetResult.Ok(DeviceLiveState(verb, 2L))
				}
			}
		}

		var putAnswer: ConsoleDeviceSchedulePutResult? = null
		var afterPut: () -> Unit = {}

		override suspend fun schedulePut(gatewayId: String, id: String, revision: Long, base: DeviceSchedule, schedule: DeviceSchedule) =
			reply {
				val plug = (readAnswer as? ConsoleDeviceReadResult.Ok)?.schedule ?: com.atelier_nyaarium.switchboard.schedule
				when {
					revision != held.revision || base != plug -> ConsoleDeviceSchedulePutResult.Refused(refusal("stale", record = held))
					else -> (putAnswer ?: ConsoleDeviceSchedulePutResult.Ok(schedule)).also { afterPut() }
				}
			}

		override suspend fun settingPut(gatewayId: String, id: String, revision: Long, setting: DeviceSettingPut) = reply {
			ConsoleDeviceSettingPutResult.Ok(settings.copy(led = false, clock = KasaClock(time = "2026-11-02T18:09:00-08:00", zone = "PST8PDT")))
		}

		override suspend fun addSensor(gatewayId: String, mac: String, name: String, radio: String, definition: String?, advert: DeviceAdvert?) =
			reply { addAnswer ?: ConsoleDeviceAddResult.Ok(sensorRecord(mac, name)) }

		override suspend fun postReading(gatewayId: String, id: String, advert: DeviceAdvert, at: Long) =
			reply<ConsoleDeviceReadingPostResult> { ConsoleDeviceReadingPostResult.Ok }

		var thresholdPut: (ConsoleOp.SensorThresholdPut) -> Unit = {}

		override suspend fun putThreshold(gatewayId: String, put: ConsoleOp.SensorThresholdPut) = reply {
			thresholdPut(put)
			ConsoleDeviceSensorThresholdPutResult.Ok(null)
		}
	}

	private class Host(override val gateway: DeviceGateway?) : DeviceHost {
		override val generation = WorkspaceGeneration()
		var present = true

		override fun names(gatewayId: String) = present
	}

	@Test
	fun `a refusal reads by its code, its effect and what landed`() {
		assertEquals("Took too long; nothing changed", refusalLine(refusal("timeout")))
		assertEquals("No answer in time; the plug may have changed", refusalLine(refusal("timeout", effect = "unknown")))
		assertEquals(
			"Not saved; 1 of 3 changes landed; the plug may have changed",
			refusalLine(refusal("write_failed", effect = "unknown", landed = DeviceLanded(1L, 3L))),
		)
		assertEquals("The plug refused (err_code -3: busy)", refusalLine(refusal("device_error", detail = "err_code -3: busy")))
	}

	@Test
	fun `a sensor read lands on its sensor slot alone, and a threshold put reads it again`() = runBlocking {
		val gateway = FakeGateway().apply {
			held = sensorRecord()
			readAnswer = sensorRead()
		}
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val first = ops.view(GW).devices.getValue(FREEZER)
		assertEquals(sensorRead(), first.sensor.read)
		assertNull(first.live)
		assertNull(first.schedule.failed)
		val set = DeviceSensorThreshold(measure = "temperature", low = -20.0, deadZone = 1.0, coolDownSec = 0, revision = 1)
		gateway.thresholdPut = { gateway.readAnswer = sensorRead(set) }
		val put = ConsoleOp.SensorThresholdPut(id = FREEZER, measure = "temperature", low = -20.0, deadZone = 1.0, coolDownSec = 0, revision = 0)
		assertEquals(DeviceSaved.Stored(null), ops.putThreshold(GW, put))
		assertEquals(listOf(set), ops.view(GW).devices.getValue(FREEZER).sensor.read?.thresholds)
	}

	@Test
	fun `a sensor read still lands on its sensor slot while its list is refused`() = runBlocking {
		val gateway = FakeGateway().apply {
			held = sensorRecord()
			readAnswer = sensorRead()
		}
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.listAnswer = ConsoleDeviceListResult.Refused(refusal("daemon_away"))
		ops.relist(GW)
		val later = sensorRead(DeviceSensorThreshold(measure = "temperature", low = -20.0, deadZone = 1.0, coolDownSec = 0, revision = 1))
		gateway.readAnswer = later
		ops.read(GW, FREEZER)
		val held = ops.view(GW).devices.getValue(FREEZER)
		assertEquals(later, held.sensor.read)
		assertNull(held.live)
	}

	@Test
	fun `opening a plug with nothing held lists first, then reads it`() = runBlocking {
		val ops = DeviceOps(Host(FakeGateway()))
		ops.open(GW, LAMP)
		assertEquals(record(), deviceRecord(ops.view(GW), LAMP))
		assertEquals(DeviceLive("off"), ops.view(GW).liveOf(LAMP))
	}

	@Test
	fun `the switch shows the flip, then the plug's own answer, and takes no second flip meanwhile`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		assertEquals(false, ops.view(GW).liveOf(LAMP).switchOn())
		val hold = TestHold()
		gateway.setHold = hold
		val flip = launch { ops.set(GW, LAMP, on = true) }
		hold.entered.await()
		assertEquals(true, ops.view(GW).liveOf(LAMP).switchOn())
		ops.set(GW, LAMP, on = false)
		assertEquals(DeviceSaved.Busy, ops.rename(GW, record(), "Desk"))
		assertEquals(1, gateway.sets)
		assertEquals(0, gateway.writes)
		hold.release()
		flip.join()
		assertEquals(DeviceLive("on"), ops.view(GW).liveOf(LAMP))
		assertFalse(ops.view(GW).busy(LAMP))
	}

	@Test
	fun `a failed set reads the plug again and says why`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.relay = "on"
		gateway.setAnswer = ConsoleDeviceSetResult.Refused(refusal("unreachable"))
		ops.set(GW, LAMP, on = true)
		assertEquals(DeviceLive("on"), ops.view(GW).liveOf(LAMP))
		assertEquals(refusalLine(refusal("unreachable")), ops.view(GW).alert(LAMP))
	}

	@Test
	fun `a failed read keeps a confirmed state stale, and with none says why`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		gateway.relay = "on"
		ops.refresh(GW)
		gateway.reachable = false
		ops.read(GW, LAMP)
		assertEquals(DeviceLive("on", stale = true, failed = GATEWAY_UNREACHABLE), ops.view(GW).liveOf(LAMP))

		val fresh = DeviceOps(Host(gateway.apply { reachable = true }))
		fresh.relist(GW)
		gateway.readAnswer = ConsoleDeviceReadResult.Refused(refusal("unreachable"))
		fresh.read(GW, LAMP)
		assertEquals(refusalLine(refusal("unreachable")), fresh.view(GW).alert(LAMP))
		assertEquals("Unknown", liveLine(fresh.view(GW).liveOf(LAMP)))
		assertNull(fresh.view(GW).detailOf(LAMP))
	}

	@Test
	fun `a flip during the opening read keeps the read's schedule and settings, and the set's state`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.relist(GW)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()
		ops.set(GW, LAMP, on = true)
		hold.release()
		slow.join()
		assertEquals(DeviceLive("on"), ops.view(GW).liveOf(LAMP))
		assertEquals(DeviceDetail(schedule, settings, 1L), ops.view(GW).detailOf(LAMP))
	}

	@Test
	fun `a setting save leaves a held read's schedule`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val moved = schedule.copy(enabled = false)
		gateway.readAnswer = ConsoleDeviceReadResult.Ok(DeviceLiveState("off", 9L), moved, settings)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()

		ops.putSetting(GW, record(), DeviceSettingPut.Kasa(KasaSettingPut.Led(false)))
		hold.release()
		slow.join()

		assertEquals(moved, ops.view(GW).detailOf(LAMP)?.schedule)
		assertEquals(false, (ops.view(GW).detailOf(LAMP)?.settings as DeviceSettings.Kasa).led)
	}

	@Test
	fun `a schedule save leaves a held read's settings`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val readSettings = settings.copy(led = false)
		gateway.readAnswer = ConsoleDeviceReadResult.Ok(DeviceLiveState("off", 9L), schedule, readSettings)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added()
		ops.editDraft(GW, LAMP, edited)

		ops.putSchedule(GW, record(), schedule, edited.toSchedule())
		hold.release()
		slow.join()

		assertEquals(edited.toSchedule(), ops.view(GW).detailOf(LAMP)?.schedule)
		assertEquals(readSettings, ops.view(GW).detailOf(LAMP)?.settings)
	}

	@Test
	fun `a held read cannot restore a removed or re-added plug`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()

		gateway.gone = true
		ops.relist(GW)
		assertEquals(DeviceListView.Listed(emptyList(), 1L), ops.view(GW).list)
		assertNull(ops.view(GW).detailOf(LAMP))
		gateway.gone = false
		ops.relist(GW)
		hold.release()
		slow.join()

		assertNull(ops.view(GW).liveOf(LAMP))
		assertNull(ops.view(GW).detailOf(LAMP))
	}

	@Test
	fun `a refused schedule save holds busy through its reread`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added()
		ops.editDraft(GW, LAMP, edited)
		gateway.putAnswer = ConsoleDeviceSchedulePutResult.Refused(refusal("device_error"))
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val first = launch { ops.putSchedule(GW, record(), schedule, edited.toSchedule()) }
		hold.entered.await()

		assertTrue(ops.view(GW).busy(LAMP))
		assertEquals(DeviceSaved.Busy, ops.putSchedule(GW, record(), schedule, edited.toSchedule()))
		assertTrue(ops.view(GW).busy(LAMP))
		hold.release()
		first.join()

		assertFalse(ops.view(GW).busy(LAMP))
		assertEquals(edited, ops.view(GW).scheduleDraft(LAMP))
	}

	@Test
	fun `a Gateway outside the roster receives no device request`() = runBlocking {
		val gateway = FakeGateway()
		val host = Host(gateway).apply { present = false }
		val ops = DeviceOps(host)
		val fan = DeviceCandidate("aa:bb:cc:dd:ee:02", "10.0.0.2", "Fan", "HS103", "3.0", "1.0.3")

		ops.open(GW, LAMP)
		ops.scan(GW)
		ops.add(GW, fan, "Fan")

		assertEquals(0, gateway.requests)
		assertEquals(DeviceListView.Unavailable(GATEWAY_UNREACHABLE), ops.view(GW).list)
		assertEquals(GATEWAY_UNREACHABLE, ops.view(GW).saidOf(fan.mac))
	}

	@Test
	fun `a refused flip while the list is unavailable still takes back its pending state`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.listAnswer = ConsoleDeviceListResult.Refused(refusal("timeout"))
		ops.relist(GW)
		gateway.setAnswer = ConsoleDeviceSetResult.Refused(refusal("unreachable"))
		ops.set(GW, LAMP, on = true)
		assertEquals(DeviceLive("off"), ops.view(GW).liveOf(LAMP))
	}

	@Test
	fun `an unreachable list keeps what was drawn, and a declining Gateway says it offers no devices`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		gateway.reachable = false
		ops.refresh(GW)
		assertEquals(DeviceListView.Unavailable(GATEWAY_UNREACHABLE), ops.view(GW).list)
		gateway.reachable = true
		ops.refresh(GW)
		gateway.reachable = false
		ops.refresh(GW)
		assertEquals(DeviceListView.Listed(listOf(record()), 1L), ops.view(GW).list)
		gateway.declined = true
		ops.relist(GW)
		assertEquals(DeviceListView.Declined, ops.view(GW).list)
	}

	@Test
	fun `every scan failure is a retry state, and found plugs leave out the paired`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		for (code in listOf("daemon_away", "timeout", "scan_failed")) {
			gateway.scanAnswer = ConsoleDeviceScanResult.Refused(refusal(code))
			ops.scan(GW)
			assertEquals(ScanView.Failed(refusalLine(refusal(code))), ops.view(GW).scan)
		}
		gateway.reachable = false
		ops.scan(GW)
		assertEquals(ScanView.Failed(GATEWAY_UNREACHABLE), ops.view(GW).scan)

		val paired = DeviceCandidate(LAMP, "10.0.0.1", "Lamp", "HS103", "3.0", "1.0.3")
		val fresh = paired.copy(mac = "aa:bb:cc:dd:ee:02", alias = "Fan")
		gateway.scanAnswer = ConsoleDeviceScanResult.Ok(listOf(paired, fresh))
		gateway.reachable = true
		ops.scan(GW)
		assertEquals(listOf(fresh), ops.view(GW).addable())
		gateway.scanAnswer = ConsoleDeviceScanResult.Ok(emptyList())
		ops.scan(GW)
		assertEquals(emptyList<DeviceCandidate>(), ops.view(GW).addable())
	}

	@Test
	fun `a failed opening read keeps its Retry through a landed flip, and through a flip made during it`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.relist(GW)
		gateway.readAnswer = ConsoleDeviceReadResult.Refused(refusal("unreachable"))
		ops.read(GW, LAMP)
		ops.set(GW, LAMP, on = true)
		assertTrue(ops.view(GW).detailRetry(LAMP))
		assertEquals(refusalLine(refusal("unreachable")), ops.view(GW).alert(LAMP))

		val during = DeviceOps(Host(gateway))
		during.relist(GW)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { during.read(GW, LAMP) }
		hold.entered.await()
		during.set(GW, LAMP, on = false)
		hold.release()
		slow.join()
		assertTrue(during.view(GW).detailRetry(LAMP))
	}

	@Test
	fun `a read begun before a schedule save does not put the old schedule back`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added()
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()
		ops.putSchedule(GW, record(), schedule, edited.toSchedule())
		hold.release()
		slow.join()
		assertEquals(listOf(evening), ops.view(GW).detailOf(LAMP)?.schedule?.rules)
	}

	@Test
	fun `a plug gone from the Gateway relists so its page can unwind`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.gone = true
		gateway.readAnswer = ConsoleDeviceReadResult.Refused(refusal("not_found"))
		ops.read(GW, LAMP)
		assertEquals(DeviceListView.Listed(emptyList(), 1L), ops.view(GW).list)
	}

	@Test
	fun `with no client a plug reads as unreachable, with a Retry`() = runBlocking {
		val ops = DeviceOps(Host(null))
		ops.open(GW, LAMP)
		assertEquals(DeviceListView.Unavailable(GATEWAY_UNREACHABLE), ops.view(GW).list)
		assertTrue(ops.view(GW).list.retryable())
	}

	@Test
	fun `an edit over a schedule that moved on the plug is dropped, and a held edit can be discarded`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added()
		ops.editDraft(GW, LAMP, edited)
		ops.read(GW, LAMP)
		assertEquals(edited, ops.view(GW).scheduleDraft(LAMP))
		ops.discardDraft(GW, LAMP)
		assertEquals(scheduleDraftOf(schedule), ops.view(GW).scheduleDraft(LAMP))

		ops.editDraft(GW, LAMP, edited)
		val moved = schedule.copy(enabled = false)
		gateway.readAnswer = ConsoleDeviceReadResult.Ok(DeviceLiveState("off", 1L), moved, settings)
		ops.read(GW, LAMP)
		assertEquals(scheduleDraftOf(moved), ops.view(GW).scheduleDraft(LAMP))
		assertFalse(ops.view(GW).scheduleSavable(LAMP))
	}

	@Test
	fun `an added plug is listed, and a refused add keeps its reason`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		val fan = DeviceCandidate("aa:bb:cc:dd:ee:02", "10.0.0.2", "Fan", "HS103", "3.0", "1.0.3")
		gateway.addAnswer = ConsoleDeviceAddResult.Refused(refusal("exists", record = record(fan.mac, "Fan")))
		assertEquals(DeviceSaved.Refused(refusalLine(refusal("exists")), "exists"), ops.add(GW, fan, "Fan"))
		assertEquals(refusalLine(refusal("exists")), ops.view(GW).saidOf(fan.mac))
		gateway.addAnswer = null
		gateway.declined = true
		assertEquals(DeviceSaved.Unanswered(GATEWAY_DECLINED), ops.add(GW, fan, "Fan"))
		assertEquals(GATEWAY_DECLINED, ops.view(GW).saidOf(fan.mac))
		gateway.declined = false
		gateway.held = record(fan.mac, "Fan")
		assertTrue(ops.add(GW, fan, "Fan") is DeviceSaved.Stored)
		assertTrue(ops.view(GW).paired(fan.mac))
		assertNull(ops.view(GW).saidOf(fan.mac))
	}

	@Test
	fun `a stale rename says so and relists the held record`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.held = record(name = "Kitchen", revision = 4L)
		gateway.renameAnswer = ConsoleDeviceRenameResult.Refused(refusal("stale", record = gateway.held))
		assertEquals(DeviceSaved.Refused(refusalLine(refusal("stale")), "stale"), ops.rename(GW, record(), "Desk"))
		assertEquals(gateway.held, deviceRecord(ops.view(GW), LAMP))
	}

	@Test
	fun `a schedule edit saves once, and a stale save adopts the held revision for the next`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added()
		assertFalse(ops.view(GW).scheduleSavable(LAMP))
		ops.editDraft(GW, LAMP, edited)
		assertTrue(ops.view(GW).scheduleSavable(LAMP))

		gateway.held = record(revision = 2L)
		val base = ops.view(GW).scheduleBase(LAMP)!!
		val first = ops.putSchedule(GW, deviceRecord(ops.view(GW), LAMP)!!, base, edited.toSchedule())
		assertEquals(DeviceSaved.Refused(refusalLine(refusal("stale")), "stale"), first)
		assertEquals(2L, deviceRecord(ops.view(GW), LAMP)?.revision)
		assertTrue(ops.view(GW).scheduleSavable(LAMP))

		val second = ops.putSchedule(GW, deviceRecord(ops.view(GW), LAMP)!!, base, edited.toSchedule())
		assertTrue(second is DeviceSaved.Stored)
		assertEquals(listOf(evening), ops.view(GW).detailOf(LAMP)?.schedule?.rules)
		assertFalse(ops.view(GW).scheduleSavable(LAMP))
	}

	@Test
	fun `a half-landed schedule save keeps the edit over what landed`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		val edited = ops.view(GW).scheduleDraft(LAMP)!!.added().added()
		ops.editDraft(GW, LAMP, edited)
		val half = schedule.copy(rules = edited.rules.take(1).map { it.copy(id = "landed") })
		gateway.putAnswer = ConsoleDeviceSchedulePutResult.Refused(
			refusal("write_failed", effect = "unknown", landed = DeviceLanded(1L, 2L)),
		)
		gateway.afterPut = { gateway.readAnswer = ConsoleDeviceReadResult.Ok(DeviceLiveState("off", 1L), half, settings) }
		ops.putSchedule(GW, record(), ops.view(GW).scheduleBase(LAMP)!!, edited.toSchedule())
		assertEquals(edited, ops.view(GW).scheduleDraft(LAMP))
		assertEquals(half, ops.view(GW).scheduleBase(LAMP))
	}

	@Test
	fun `a scan rereads a plug it found at a new address`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		gateway.readAnswer = ConsoleDeviceReadResult.Refused(refusal("unreachable"))
		ops.refresh(GW)
		assertTrue(ops.view(GW).detailRetry(LAMP))
		gateway.held = record().copy(address = "10.0.0.9")
		gateway.readAnswer = null
		ops.scan(GW)
		assertFalse(ops.view(GW).detailRetry(LAMP))
		assertEquals(DeviceLive("off"), ops.view(GW).liveOf(LAMP))
	}

	@Test
	fun `nothing begun before a re-provision lands after it`() = runBlocking {
		val gateway = FakeGateway()
		val host = Host(gateway)
		val ops = DeviceOps(host)
		ops.refresh(GW)
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()
		host.generation.advance()
		ops.clearInMemory()
		ops.relist(GW)
		hold.release()
		slow.join()
		assertEquals(DeviceListView.Listed(listOf(record()), 1L), ops.view(GW).list)
		assertNull(ops.view(GW).liveOf(LAMP))
		assertNull(ops.view(GW).detailOf(LAMP))
	}

	@Test
	fun `a read whose details slot a save claimed still lands its live state`() = runBlocking {
		val gateway = FakeGateway()
		val ops = DeviceOps(Host(gateway))
		ops.refresh(GW)
		gateway.relay = "on"
		val hold = TestHold()
		gateway.readHolds.addLast(hold)
		val slow = launch { ops.read(GW, LAMP) }
		hold.entered.await()
		ops.putSetting(GW, record(), DeviceSettingPut.Kasa(KasaSettingPut.Led(false)))
		hold.release()
		slow.join()
		assertEquals(DeviceLive("on"), ops.view(GW).liveOf(LAMP))
		assertEquals(false, (ops.view(GW).detailOf(LAMP)?.settings as DeviceSettings.Kasa).led)
	}

	@Test
	fun `a setting put lands its value and keeps the clock its read paired`() = runBlocking {
		val ops = DeviceOps(Host(FakeGateway()))
		ops.refresh(GW)
		ops.putSetting(GW, record(), DeviceSettingPut.Kasa(KasaSettingPut.Led(false)))
		assertEquals(DeviceDetail(schedule, settings.copy(led = false), 1L), ops.view(GW).detailOf(LAMP))
	}

	@Test
	fun `a re-provision empties every Gateway's plug views`() = runBlocking {
		val ops = DeviceOps(Host(FakeGateway()))
		ops.refresh(GW)
		assertEquals(DeviceLive("off"), ops.view(GW).liveOf(LAMP))
		ops.clearInMemory()
		assertEquals(DevicesView(), ops.view(GW))
	}
}
