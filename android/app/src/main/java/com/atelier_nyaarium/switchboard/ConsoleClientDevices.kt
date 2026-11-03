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
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
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
		client.deviceCall(gatewayId, ConsoleOp.DeviceAdd(mac, address, name), ConsoleDeviceAddResult.serializer())

	override suspend fun rename(gatewayId: String, id: String, name: String, revision: Long) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceRename(id, name, revision), ConsoleDeviceRenameResult.serializer())

	override suspend fun remove(gatewayId: String, id: String, revision: Long) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceRemove(id, revision), ConsoleDeviceRemoveResult.serializer())

	override suspend fun set(gatewayId: String, id: String, verb: String) =
		client.deviceCall(gatewayId, ConsoleOp.DeviceSet(id, verb), ConsoleDeviceSetResult.serializer())

	override suspend fun schedulePut(gatewayId: String, id: String, revision: Long, base: DeviceSchedule, schedule: DeviceSchedule) =
		client.deviceCall(
			gatewayId,
			ConsoleOp.DeviceSchedulePut(id, revision, base, schedule),
			ConsoleDeviceSchedulePutResult.serializer(),
		)

	override suspend fun settingPut(gatewayId: String, id: String, revision: Long, setting: DeviceSettingPut) =
		client.deviceCall(
			gatewayId,
			ConsoleOp.DeviceSettingPut(id, revision, setting),
			ConsoleDeviceSettingPutResult.serializer(),
		)
}
