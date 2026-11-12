package dev.atlas.android

// The Android app's activity. `scripts/build.js android` writes this file
// over the one `tauri android init` generates (src-tauri/gen/android, which
// is made again for every build), keeping the generated package line.
//
// The app draws edge to edge, under the status bar, the navigation bar and
// any display cutout: Android enforces that for apps that target Android 15
// or later. The page pads itself by their sizes. WebView versions differ in
// whether they report them to the page (`env(safe-area-inset-*)`), so this
// activity reads the window insets itself and hands them over as
// `window.AtlasAndroid.insets()` and an `atlas-insets` event, in CSS pixels
// (see apps/web/src/androidBars.ts). The page also says which theme it
// shows, so the bar icons stay readable, and whether to keep the screen on.
//
// Back: the page first closes what it shows on top (a dialog, a sheet,
// search, a section other than the map) through `window.atlasBack()`,
// which says whether it closed something; only when it did not does Back
// leave the app. Tauri's own back callback goes back through the WebView's
// history, which the page does not use.

import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  /** The insets as "top,right,bottom,left" in CSS pixels. */
  @Volatile private var insets = "0,0,0,0"

  private var page: WebView? = null

  /** Asks the page to close what it shows on top; leaves the app when it has nothing to close. */
  private val back = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      val view = page
      if (view == null) {
        leave()
        return
      }
      view.evaluateJavascript("window.atlasBack ? window.atlasBack() === true : false") { result ->
        if (result != "true") leave()
      }
    }

    private fun leave() {
      // The next callback, or the activity's own Back, which closes the app.
      isEnabled = false
      onBackPressedDispatcher.onBackPressed()
      isEnabled = true
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    // Added again so it comes before callbacks added since (Tauri's own).
    back.remove()
    onBackPressedDispatcher.addCallback(this, back)
  }

  override fun onWebViewCreate(webView: WebView) {
    page = webView
    // Before the page loads, so the page finds it when it starts.
    webView.addJavascriptInterface(Bars(), "AtlasAndroid")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      fun css(pixels: Int): Int = (pixels / density).roundToInt()
      val now = "${css(bars.top)},${css(bars.right)},${css(bars.bottom)},${css(bars.left)}"
      if (now != insets) {
        insets = now
        (view as WebView).evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('atlas-insets', { detail: '$now' }))",
          null
        )
      }
      // The WebView's own handling as well: it may report them to the page.
      ViewCompat.onApplyWindowInsets(view, windowInsets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** What the page may call, as `window.AtlasAndroid`. Nothing else is exposed. */
  inner class Bars {
    @JavascriptInterface
    fun insets(): String = this@MainActivity.insets

    /** Dark icons on the bars for a light page, light icons for a dark one. */
    @JavascriptInterface
    fun darkIcons(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = dark
        controller.isAppearanceLightNavigationBars = dark
      }
    }

    /** Keeps the screen on while the app is shown, or lets it turn off as usual. */
    @JavascriptInterface
    fun keepScreenOn(on: Boolean) {
      runOnUiThread {
        if (on) {
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }
  }
}
