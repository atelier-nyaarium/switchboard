package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ReportRead
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

fun composeReportRead(stream: String, anchor: ReadAnchor, at: Long): JsonObject =
	wireJson.encodeToJsonElement(
		ReportRead.serializer(),
		ReportRead(stream = stream, epoch = anchor.epoch, seq = anchor.seq, at = at),
	).jsonObject
