package com.atelier_nyaarium.switchboard.vault

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * The one reader of whether this device lets the console draw over other apps.
 *
 * Two things ask: the prompt, which cannot be added to the window manager without it, and the
 * capability report, which must not offer a vault whose requests would never reach the owner.
 * Read in two places with two spellings, they could disagree and the console would promise a
 * surface nothing draws.
 */
object OverlayPermission {
	fun granted(context: Context): Boolean = android.provider.Settings.canDrawOverlays(context)

	/** Android offers no request dialog for this one; the owner grants it on a settings screen. */
	fun grantIntent(context: Context): Intent =
		Intent(
			android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
			Uri.parse("package:${context.packageName}"),
		)
}
