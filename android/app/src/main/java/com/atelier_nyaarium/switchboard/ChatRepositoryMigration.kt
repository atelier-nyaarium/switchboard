package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.update

// Cursor translation and self-migration wiring.

internal fun ChatRepository.wireMigration() {
	cursorTranslation = CursorTranslationOps(
		coordinator = transportCoordinator,
		journal = mutationJournal,
		address = { "owner:${localDomain()}/${federation.ownerSignPub()}" },
		heldCursor = { mailboxSync.pollParams().epoch to mailboxSync.pollParams().cursor },
		sign = { op, opId -> ownerOps.sign(op, opId) },
		send = { client().postOwnerOp(it) },
		reportError = { message -> _state.update { it.copy(error = message) } },
		commit = { gen, cursor, epoch -> socket.commitTranslation(gen, cursor, epoch) },
		ambient = ambient,
	)
	selfMigration = SelfMigration(
		readAnchors = { _state.value.readAnchors },
		journal = mutationJournal,
		reportRead = { team, anchor ->
			val signed = ownerOps.sign(composeReportRead(team, anchor, System.currentTimeMillis()))
			if (signed == null) null else client().postOwnerOp(signed)
		},
		reportError = { message -> _state.update { it.copy(error = message) } },
		resetAccepted = {
			_state.update { s -> s.copy(scheduledSends = s.scheduledSends.mapValues { (_, rec) -> rec.copy(routerVersion = null, replacesVersion = null) }) }
			persistence.persistScheduledSends(_state.value.scheduledSends)
		},
	)
}
