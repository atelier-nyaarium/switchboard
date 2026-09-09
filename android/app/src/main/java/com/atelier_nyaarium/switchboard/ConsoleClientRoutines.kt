package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineListResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineNextResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineOccurrenceResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutinePutResult
import com.atelier_nyaarium.switchboard.proto.ConsoleRoutineRunResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Routine

// A routine runs on one gateway, so every call names the one it means.

suspend fun ConsoleClient.routineList(gatewayId: String): ConsoleRoutineListResult =
	valueResult(sendValueOp(gatewayId, ConsoleOp.RoutineList), Protocol.Wire.ConsoleOpKind.ROUTINE_LIST)

suspend fun ConsoleClient.routinePut(
	gatewayId: String,
	routine: Routine,
	baseRevision: Long? = null,
): ConsoleRoutinePutResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutinePut(routine = routine, baseRevision = baseRevision)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_PUT,
	)

suspend fun ConsoleClient.routineNext(gatewayId: String, routine: Routine): ConsoleRoutineNextResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineNext(routine = routine)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_NEXT,
	)

suspend fun ConsoleClient.routineDelete(gatewayId: String, routineId: String): ConsoleRoutineDeleteResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineDelete(routineId = routineId)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_DELETE,
	)

suspend fun ConsoleClient.routineEnable(
	gatewayId: String,
	routineId: String,
	enabled: Boolean,
): ConsoleRoutinePutResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineEnable(routineId = routineId, enabled = enabled)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_ENABLE,
	)

suspend fun ConsoleClient.routineRunNow(
	gatewayId: String,
	routineId: String,
	occurrenceId: String,
): ConsoleRoutineOccurrenceResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineRunNow(routineId = routineId, occurrenceId = occurrenceId)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_RUN_NOW,
	)

/** No instant: the gateway owns `now`, and answers the occurrence it opened. */
suspend fun ConsoleClient.routineRun(gatewayId: String, routineId: String): ConsoleRoutineRunResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineRun(routineId = routineId)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_RUN,
	)

suspend fun ConsoleClient.routineDismiss(
	gatewayId: String,
	routineId: String,
	occurrenceId: String,
): ConsoleRoutineOccurrenceResult =
	valueResult(
		sendValueOp(gatewayId, ConsoleOp.RoutineDismiss(routineId = routineId, occurrenceId = occurrenceId)),
		Protocol.Wire.ConsoleOpKind.ROUTINE_DISMISS,
	)
