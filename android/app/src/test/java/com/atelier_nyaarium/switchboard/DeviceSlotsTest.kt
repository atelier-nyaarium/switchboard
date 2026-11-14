package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.KasaClock
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

private val firstRecord = DeviceRecord(
	id = "aa:bb:cc:dd:ee:01",
	name = "Lamp",
	kind = "switch",
	driver = "kasa",
	address = "10.0.0.1",
	revision = 1L,
)

private val secondRecord = firstRecord.copy(id = "aa:bb:cc:dd:ee:02", name = "Fan", address = "10.0.0.2")
private val firstSchedule = DeviceSchedule(enabled = true, rules = emptyList())
private val secondSchedule = DeviceSchedule(enabled = false, rules = emptyList())
private val firstSettings = DeviceSettings.Kasa(
	led = true,
	clock = KasaClock(time = "2026-11-02T18:00:00-08:00", zone = "PST8PDT"),
	cloud = "bound",
)
private val secondSettings = firstSettings.copy(led = false)

class DeviceSlotsTest {
	@Test
	fun `distinct slots leave another owned part unchanged`() {
		val firstPlug = HeldDevice(
			incarnation = 1L,
			live = DeviceLive("on"),
			schedule = ScheduleHeld(firstSchedule, ScheduleEdit(firstSchedule, scheduleDraftOf(firstSchedule))),
			settings = SettingsHeld(firstSettings, 1L),
		)
		val secondPlug = HeldDevice(
			incarnation = 2L,
			live = DeviceLive("off"),
			schedule = ScheduleHeld(secondSchedule),
			settings = SettingsHeld(secondSettings, 2L),
		)
		val samples = listOf(
			DevicesView(),
			DevicesView(
				list = DeviceListView.Listed(listOf(firstRecord), 1L),
				devices = mapOf(firstRecord.id to firstPlug),
				work = mapOf(firstRecord.id to Work(true, "held")),
				minted = 1L,
			),
			DevicesView(
				list = DeviceListView.Listed(listOf(firstRecord, secondRecord), 2L),
				devices = mapOf(firstRecord.id to firstPlug, secondRecord.id to secondPlug),
				work = mapOf("candidate" to Work(true, "waiting")),
				minted = 2L,
			),
			DevicesView(
				list = DeviceListView.Listed(listOf(secondRecord), 3L),
				devices = mapOf(secondRecord.id to secondPlug),
				work = mapOf("candidate" to Work(true)),
				minted = 2L,
			),
		)
		val listing = DeviceSlot.Listing
		val scan = DeviceSlot.Scan

		for (view in samples) {
			val listed = (view.list as? DeviceListView.Listed)?.records.orEmpty()
			val nextList = DeviceListView.Listed(listed, (view.list as? DeviceListView.Listed)?.revision?.plus(1) ?: 1L)
			val changes: List<SlotChange> = listOf(
				Change(listing, nextList),
				Change(scan, ScanView.Found(emptyList())),
				Change(DeviceSlot.Writing("candidate"), Work(false, "write")),
				Change(DeviceSlot.Writing(firstRecord.id), Work(false, "write")),
				Change(DeviceSlot.Live(firstRecord.id, 1L), DeviceLive("off")),
				Change(DeviceSlot.Schedule(firstRecord.id, 1L), ScheduleHeld(secondSchedule)),
				Change(DeviceSlot.Settings(firstRecord.id, 1L), SettingsHeld(secondSettings, 4L)),
				Change(DeviceSlot.Live(secondRecord.id, 2L), DeviceLive("on")),
				Change(DeviceSlot.Schedule(secondRecord.id, 2L), ScheduleHeld(firstSchedule)),
				Change(DeviceSlot.Settings(secondRecord.id, 2L), SettingsHeld(firstSettings, 5L)),
			)
			for (writer in changes) {
				for (reader in changes) {
					if (writer.slot == reader.slot || !writer.owned(view)) continue
					assertTrue(reader.unchanged(view, writer.write(view)))
				}
			}
		}
	}

	@Test
	fun `listing keeps drops and remints devices`() {
		val first = DeviceSlot.Listing.write(DevicesView(), DeviceListView.Listed(listOf(firstRecord), 1L))
		val heldPlug = first.devices.getValue(firstRecord.id)
		val kept = DeviceSlot.Listing.write(first, DeviceListView.Listed(listOf(firstRecord), 2L))
		assertSame(heldPlug, kept.devices[firstRecord.id])

		val dropped = DeviceSlot.Listing.write(kept, DeviceListView.Listed(emptyList(), 3L))
		assertNull(dropped.devices[firstRecord.id])
		val readded = DeviceSlot.Listing.write(dropped, DeviceListView.Listed(listOf(firstRecord), 4L))
		assertNotNull(readded.devices[firstRecord.id])
		assertTrue(readded.devices.getValue(firstRecord.id).incarnation > heldPlug.incarnation)
		val unavailable = DeviceSlot.Listing.write(readded, DeviceListView.Unavailable("offline"))
		val loading = DeviceSlot.Listing.write(readded, DeviceListView.Loading)
		assertSame(readded.devices, unavailable.devices)
		assertSame(readded.devices, loading.devices)

		val scanned = DeviceSlot.Scan.write(readded, ScanView.Found(emptyList()))
		assertSame(readded.devices, scanned.devices)
	}

	private interface SlotChange {
		val slot: Any

		fun owned(view: DevicesView): Boolean

		fun write(view: DevicesView): DevicesView

		fun unchanged(before: DevicesView, after: DevicesView): Boolean
	}

	private data class Change<S>(val typed: DeviceSlot<S>, val part: S) : SlotChange {
		override val slot: Any get() = typed

		override fun owned(view: DevicesView) = typed.owned(view)

		override fun write(view: DevicesView) = typed.write(view, part)

		override fun unchanged(before: DevicesView, after: DevicesView): Boolean =
			!typed.owned(before) || !typed.owned(after) || typed.read(before) == typed.read(after)
	}
}
