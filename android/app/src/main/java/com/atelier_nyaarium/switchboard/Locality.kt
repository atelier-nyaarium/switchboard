package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address

/** The phone's own word on locality; the gateway's `requireLocalComposite` stays the authority. */
internal fun GatewayRegistry.owns(target: Address, domainId: String): Boolean =
	target.domain == domainId && has(target.gateway)
