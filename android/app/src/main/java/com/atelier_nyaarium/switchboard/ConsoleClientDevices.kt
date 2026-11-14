package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceAddResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRemoveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceRenameResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceHomeNetworkResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceScanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSchedulePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSetResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSettingPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceReadingPostResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceSensorThresholdPutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.DeviceAdvert
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import kotlinx.serialization.KSerializer

private suspend fun <T> ConsoleClient.deviceCall(gatewayId: String, op: ConsoleOp, serializer: KSerializer<T>): DeviceAnswer<T> =
	when (val answer = sendValueAnswer(gatewayId, op)) {
		is ConsoleClient.ValueAnswer.Answered ->
			runIsolated { wireJson.decodeFromJsonElement(serializer, answer.result) }.fold({ DeviceAnswer.Answered(it) }) {
				DebugLog.log("Device", "${op::class.simpleName} answer did not decode: ${it::class.simpleName}")
				DeviceAnswer.Unreachable
			}
		is ConsoleClient.ValueAnswer.Refused -> DeviceAnswer.Declined
		is ConsoleClient.ValueAnswer.Undelivered -> DeviceAnswer.Unreachable
		ConsoleClient.ValueAnswer.Unreachable -> DeviceAnswer.Unreachable
	}

/** Device ops over the Router. */
internal class ConsoleDeviceGateway(private val client: ConsoleClient) : DeviceGateway {
	override suspend fun list(gatewayId: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceList, ConsoleDeviceListResult.serializer())

	override suspend fun read(gatewayId: String, id: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceRead(id), ConsoleDeviceReadResult.serializer())

	override suspend fun scan(gatewayId: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceScan, ConsoleDeviceScanResult.serializer())

	override suspend fun homeNetwork(gatewayId: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceHomeNetwork, ConsoleDeviceHomeNetworkResult.serializer())

	override suspend fun add(gatewayId: String, mac: String, address: String, name: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceAdd(mac = mac, address = address, name = name), ConsoleDeviceAddResult.serializer())

	override suspend fun addSensor(
		gatewayId: String,
		mac: String,
		name: String,
		radio: String,
		definition: String?,
		advert: DeviceAdvert?,
	) = client.deviceCall(
		gatewayId,
		ConsoleOp.DeviceAdd(mac = mac, name = name, radio = radio, definition = definition, advert = advert),
		ConsoleDeviceAddResult.serializer(),
	)

	override suspend fun postReading(gatewayId: String, id: String, advert: DeviceAdvert, at: Long) =
		client.deviceCall(
			gatewayId,
			ConsoleOp.DeviceReadingPost(id = id, advert = advert, at = at),
			ConsoleDeviceReadingPostResult.serializer(),
		)

	override suspend fun putThreshold(gatewayId: String, put: ConsoleOp.SensorThresholdPut) =
		client.deviceCall(gatewayId, put, ConsoleDeviceSensorThresholdPutResult.serializer())

	override suspend fun rename(gatewayId: String, id: String, name: String, revision: Long) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceRename(id = id, name = name, revision = revision), ConsoleDeviceRenameResult.serializer())

	override suspend fun remove(gatewayId: String, id: String, revision: Long) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceRemove(id = id, revision = revision), ConsoleDeviceRemoveResult.serializer())

	override suspend fun set(gatewayId: String, id: String, verb: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceSet(id = id, verb = verb), ConsoleDeviceSetResult.serializer())

	override suspend fun schedulePut(gatewayId: String, id: String, revision: Long, base: DeviceSchedule, schedule: DeviceSchedule) =
		client.deviceCall(
			gatewayId,
			ConsoleOp.DeviceSchedulePut(id = id, revision = revision, base = base, schedule = schedule),
			ConsoleDeviceSchedulePutResult.serializer(),
		)

	override suspend fun settingPut(gatewayId: String, id: String, revision: Long, setting: DeviceSettingPut) =
		client.deviceCall(
			gatewayId,
			ConsoleOp.DeviceSettingPut(id = id, revision = revision, setting = setting),
			ConsoleDeviceSettingPutResult.serializer(),
		)
}
