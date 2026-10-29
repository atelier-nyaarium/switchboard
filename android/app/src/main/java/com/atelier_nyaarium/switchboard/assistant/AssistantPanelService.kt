package com.atelier_nyaarium.switchboard.assistant

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import com.atelier_nyaarium.switchboard.runIsolated

/** The assistant role's service; the panel is its session. */
class AssistantVoiceService : VoiceInteractionService()

class AssistantPanelSessionService : VoiceInteractionSessionService() {
	override fun onNewSession(args: Bundle?): VoiceInteractionSession = AssistantPanelSession(this)
}

/** The role requires one. It never asks for the microphone, so it never listens. */
class AssistantRecognitionService : RecognitionService() {
	override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
		runIsolated { listener?.error(android.speech.SpeechRecognizer.ERROR_RECOGNIZER_BUSY) }
	}

	override fun onCancel(listener: Callback?) = Unit

	override fun onStopListening(listener: Callback?) = Unit
}

/** False until the owner re-picks the assistant after the session shipped. */
internal fun assistantSessionAdopted(context: Context): Boolean = runIsolated {
	VoiceInteractionService.isActiveService(context, ComponentName(context, AssistantVoiceService::class.java))
}.getOrDefault(false)
