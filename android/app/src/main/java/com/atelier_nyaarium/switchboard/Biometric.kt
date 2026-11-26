package com.atelier_nyaarium.switchboard

import android.app.KeyguardManager
import android.content.Context
import android.content.ContextWrapper
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Through wrappers; a dialog's context is one. */
fun Context.fragmentActivity(): FragmentActivity? =
	generateSequence(this) { (it as? ContextWrapper)?.baseContext }.firstNotNullOfOrNull { it as? FragmentActivity }

/** The activity a prompt shows on. */
@Composable
fun hostActivity(): FragmentActivity? = LocalContext.current.fragmentActivity()

private const val AUTHENTICATORS =
	BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

private const val APP_LOCK_TITLE = "Unlock Switchboard"
private const val APP_LOCK_SUBTITLE = "Authenticate to access your chats"

/** How one prompt ended. */
enum class OwnerPrompt {
	PASSED,

	/** The owner backed out. */
	REFUSED,

	/** Nothing to ask with. */
	NO_SCREEN_LOCK,

	/** The phone could not ask. */
	COULD_NOT_ASK,
}

/** Who gets through. */
fun passes(answer: OwnerPrompt): Boolean = answer == OwnerPrompt.PASSED || answer == OwnerPrompt.NO_SCREEN_LOCK

/** Null shows the prompt. `secure`: the phone has a screen lock. */
internal fun promptWithout(secure: Boolean, status: Int): OwnerPrompt? = when {
	!secure -> OwnerPrompt.NO_SCREEN_LOCK
	status == BiometricManager.BIOMETRIC_SUCCESS -> null
	else -> OwnerPrompt.COULD_NOT_ASK
}

/** A prompt's error code; unanswered is a refusal. */
internal fun promptError(code: Int): OwnerPrompt = when (code) {
	BiometricPrompt.ERROR_USER_CANCELED,
	BiometricPrompt.ERROR_NEGATIVE_BUTTON,
	BiometricPrompt.ERROR_CANCELED,
	BiometricPrompt.ERROR_TIMEOUT,
	-> OwnerPrompt.REFUSED
	else -> OwnerPrompt.COULD_NOT_ASK
}

/** Shows the biometric or device-credential prompt. */
fun promptUnlock(
	activity: FragmentActivity,
	title: String = APP_LOCK_TITLE,
	subtitle: String = APP_LOCK_SUBTITLE,
	onResult: (OwnerPrompt) -> Unit,
): BiometricPrompt? {
	val secure = activity.getSystemService(KeyguardManager::class.java)?.isDeviceSecure != false
	promptWithout(secure, BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS))?.let {
		onResult(it)
		return null
	}
	val prompt = BiometricPrompt(
		activity,
		ContextCompat.getMainExecutor(activity),
		object : BiometricPrompt.AuthenticationCallback() {
			override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(OwnerPrompt.PASSED)
			override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(promptError(errorCode))
		},
	)
	val info = BiometricPrompt.PromptInfo.Builder()
		.setTitle(title)
		.setSubtitle(subtitle)
		.setAllowedAuthenticators(AUTHENTICATORS)
		.build()
	prompt.authenticate(info)
	return prompt
}

/** Every gated action asks through `requireOwnerPresent`. */
private suspend fun promptBiometric(activity: FragmentActivity, title: String, subtitle: String): OwnerPrompt =
	suspendCancellableCoroutine { cont ->
		val prompt = promptUnlock(activity, title, subtitle) { answer -> if (cont.isActive) cont.resume(answer) }
		cont.invokeOnCancellation { prompt?.cancelAuthentication() }
	}

/** Nothing to prompt on could not ask. */
suspend fun requireOwnerPresent(
	activity: FragmentActivity?,
	title: String = APP_LOCK_TITLE,
	subtitle: String = APP_LOCK_SUBTITLE,
): OwnerPrompt = if (activity == null) OwnerPrompt.COULD_NOT_ASK else promptBiometric(activity, title, subtitle)
