package com.atelier_nyaarium.switchboard.plugins.references

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.atelier_nyaarium.switchboard.Attachments
import com.atelier_nyaarium.switchboard.Repo
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.workspace.WorkspaceOpen
import com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenBus
import com.atelier_nyaarium.switchboard.workspace.WorkspaceOpenRequest
import org.json.JSONObject

////////////////////////////////
//  Composable

/**
 * The full-screen code viewer for one tapped ref.
 *
 * Same resource posture as the thread renderer: everything is a local asset, and any other request
 * is blocked outright, so a snapshot of an arbitrary project file can never cause a fetch.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ReferenceViewer(
	request: ReferenceOpenRequest,
	onLeave: () -> Unit,
	modifier: Modifier = Modifier,
) = androidx.compose.runtime.key(request) {
	// key(request) owns the whole lifecycle: a request swap under a live viewer tears this subtree
	// down (releasing the WebView) and rebuilds it fresh, so the one-shot factory closure can never
	// render a previous ref's payload under the new request. produceState alone does NOT give this -
	// its backing state is remembered unkeyed, only its effect restarts.
	val context = LocalContext.current
	val dark = !MaterialTheme.colorScheme.background.let { it.red + it.green + it.blue > 1.5f }
	// Off the main thread: the payload build reads the whole snapshot file. The WebView composes
	// only once the read has SETTLED (Result present, its value possibly null for a gone snapshot),
	// so the factory always sees the final answer - never a race against a still-running read.
	val loaded by androidx.compose.runtime.produceState<Result<SentSnapshot?>?>(initialValue = null) {
		value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
			runIsolated {
				Attachments.resolve(context.filesDir, request.rel)?.readText()?.let { text ->
					SentSnapshot(payloadFor(request, text), sentLines(request.meta, request.key, text))
				}
			}
		}
	}
	val now = rememberRefNow(request, loaded?.getOrNull()?.lines)
	var showNow by remember { androidx.compose.runtime.mutableStateOf(false) }
	var page by remember { androidx.compose.runtime.mutableStateOf<WebView?>(null) }
	val differs = now as? RefNow.Differs
	val shown = if (showNow && differs != null) nowPayloadFor(request, differs) else loaded?.getOrNull()?.payload
	androidx.compose.runtime.LaunchedEffect(page, shown) {
		val view = page ?: return@LaunchedEffect
		shown?.let { view.evaluateJavascript("window.refview.render($it)", null) }
	}

	val settled = loaded
	// Branch rather than return early: a non-local return out of an inline lambda emits a marker
	// D8 cannot represent in dex, so the whole APK fails to build while the JVM tests stay green.
	if (settled == null) {
		Box(modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
			androidx.compose.material3.CircularProgressIndicator()
		}
	} else {
		// A read that THREW (an unreadable or oversize snapshot) is a different fact than a snapshot
		// that is simply gone, and the page says which.
		val payload = settled.getOrNull()?.payload
		val failureNote =
			if (settled.isFailure) "Couldn't open this snapshot." else "This snapshot is no longer available on this device."
		Column(modifier.fillMaxSize()) {
		if (differs != null) ChangedStrip(showNow) { showNow = it }
		Box(Modifier.weight(1f)) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			// Each dismissal must take its renderer process with it; the sibling Designer WebViews do
			// the same. Without it, every ref tap in a session leaves one behind.
			onRelease = { it.destroy() },
			factory = { ctx ->
				WebView(ctx).apply {
					settings.javaScriptEnabled = true
					settings.allowFileAccess = false
					settings.allowContentAccess = false
					isVerticalScrollBarEnabled = true

					addJavascriptInterface(
						object {
							@JavascriptInterface
							fun ready() {
								post {
									evaluateJavascript("window.refview.setTheme($dark)", null)
									if (payload != null) {
									// Renders through the effect, which also re-renders on the toggle.
									page = this@apply
								} else {
									// The tap was already claimed, so the link menu is unreachable. Say what
									// happened rather than leaving a blank page that reads as a dead tap.
									val note = JSONObject.quote(failureNote)
									evaluateJavascript("window.refview.unavailable($note)", null)
								}
								}
							}
						},
						"Android",
					)

					webViewClient = object : WebViewClient() {
						// A large snapshot builds tens of thousands of nodes, which is the shape that
						// OOMs a renderer. Returning true keeps the app alive instead of letting the
						// framework kill the process out from under the conversation.
						override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true

						override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
							if (request.url.scheme == "file") null else WebResourceResponse("text/plain", "utf-8", null)

						override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
					}

					loadUrl("file:///android_asset/refview/refview.html")
					}
				},
			)
		}
		RefExitRow(request, onLeave)
		}
	}
}

private class SentSnapshot(val payload: String, val lines: List<String>?)

@Composable
private fun rememberRefNow(request: ReferenceOpenRequest, sent: List<String>?): RefNow {
	if (!comparable(request.key)) return RefNow.Unknown
	val symbolId = request.key.symbolId ?: return RefNow.Unknown
	val views = Repo.get(LocalContext.current).symbolViews
	val target = remember(request.team) { WorkspaceTarget(gatewayId = gatewayOf(request.team), address = request.team) }
	androidx.compose.runtime.LaunchedEffect(target, symbolId) { views.keepRefNow(target, symbolId) }
	val all by views.refNowViews.collectAsState()
	val view = all[target to symbolId]
	val declared = (view?.source as? WorkspaceAnswer.Read)?.value?.let { it.startLine..it.endLine }
	val file = (view?.file as? WorkspaceAnswer.Read)?.value?.text
	return remember(sent, declared, file) { refNow(request.key, sent, declared, file) }
}

@Composable
private fun ChangedStrip(showNow: Boolean, onShowNow: (Boolean) -> Unit) {
	Column(Modifier.fillMaxWidth()) {
		androidx.compose.material3.Text(
			"Changed since sent",
			Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 14.dp, vertical = 8.dp),
			style = MaterialTheme.typography.labelLarge,
		)
		SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
			SegmentedButton(
				selected = !showNow,
				onClick = hapticClick { onShowNow(false) },
				shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
			) { androidx.compose.material3.Text("Sent") }
			SegmentedButton(
				selected = showNow,
				onClick = hapticClick { onShowNow(true) },
				shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
			) { androidx.compose.material3.Text("Now") }
		}
	}
}

/** The snapshot records what the agent meant; these reach what the code says now. */
@Composable
private fun RefExitRow(request: ReferenceOpenRequest, onLeave: () -> Unit) {
	val exits = remember(request) { exitsFor(request.meta, request.key) }
	if (exits.filePath == null && exits.symbolId == null) return

	Row(
		Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
		horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(9.dp),
	) {
		exits.filePath?.let { path ->
			androidx.compose.material3.OutlinedButton(
				onClick = com.atelier_nyaarium.switchboard.hapticClick {
					WorkspaceOpenBus.request(WorkspaceOpenRequest(request.team, WorkspaceOpen.File(path)))
					onLeave()
				},
			) { androidx.compose.material3.Text("Open File") }
		}
		exits.symbolId?.let { id ->
			androidx.compose.material3.Button(
				onClick = com.atelier_nyaarium.switchboard.hapticClick {
					WorkspaceOpenBus.request(WorkspaceOpenRequest(request.team, WorkspaceOpen.Window(id)))
					onLeave()
				},
				modifier = Modifier.weight(1f),
			) { androidx.compose.material3.Text("Open Window") }
		}
	}
}
