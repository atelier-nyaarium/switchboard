package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult

/** Test reads; main sources fold every answer. */
fun <T> GatewayList<T>.listedRows(): List<T>? = (this as? GatewayList.Listed)?.rows

fun <T> Lookup<T>.found(): T? = (this as? Lookup.Found)?.row

fun GatewayRegistry.assistantOn(gatewayId: String): ConsoleAssistantStateResult? =
	(assistantRead(gatewayId) as? AssistantRead.Answered)?.state
