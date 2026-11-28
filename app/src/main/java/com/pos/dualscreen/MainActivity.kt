package com.pos.dualscreen

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Presentation
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Display
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Thin dual-screen shell for the Ultra POS web app.
 *
 * Display 0 (10.1" cashier touchscreen) shows [PREF_MAIN_URL] in a full-screen WebView.
 * The first presentation display (4.5" customer screen) shows [PREF_CUSTOMER_URL] in a
 * WebView inside an [android.app.Presentation]. Both WebViews live in the same process, so
 * same-origin localStorage / IndexedDB / BroadcastChannel are shared between the screens.
 *
 * Tap the top-left corner 5 times quickly to change the URLs on the terminal.
 */
class MainActivity : ComponentActivity() {

    private lateinit var mainWebView: WebView
    private var printerBridge: NativePrinterBridge? = null
    private lateinit var displayManager: DisplayManager
    private var customerPresentation: CustomerPresentation? = null
    private var overlayPromptShown = false
    private var urlDialog: AlertDialog? = null
    private var autoCustomerUrl: String? = null
    private var lastCashierUrl: String? = null
    /** True while the cashier screen is visible; the customer screen only shows then. */
    private var inForeground = false

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }
    private val mainHandler = Handler(Looper.getMainLooper())

    // 5-tap hotspot state
    private var hotspotTapCount = 0
    private var hotspotFirstTapAt = 0L

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = refreshPresentation()
        override fun onDisplayRemoved(displayId: Int) = refreshPresentation()
        override fun onDisplayChanged(displayId: Int) {
            // Only rebuild if the display we're on went away or a better one appeared.
            val current = customerPresentation
            if (current == null || current.display.displayId == displayId) refreshPresentation()
        }
    }

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        mainWebView = createCashierWebView()
        // Bluetooth/USB receipt printing (WebView has no Web Bluetooth or WebUSB).
        printerBridge = NativePrinterBridge(this) { mainUrl() }.also { it.attach(mainWebView) }
        setContentView(mainWebView)
        enterImmersive()

        // After Android recreates the app, load the page the cashier was on. (WebView.restoreState
        // can leave a blank white page, since it no longer restores what was on screen.)
        val savedUrl = savedInstanceState?.getString(STATE_CASHIER_URL)?.takeIf { it.startsWith("http") }
        mainWebView.loadUrl(savedUrl ?: mainUrl())

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Never let a stray back gesture close the POS.
                if (mainWebView.canGoBack()) mainWebView.goBack()
            }
        })

        displayManager = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        displayManager.registerDisplayListener(displayListener, mainHandler)
    }

    override fun onStart() {
        super.onStart()
        inForeground = true
        refreshPresentation()
    }

    override fun onStop() {
        // The cashier left the app (Home, recents, another app, screen off): close the customer
        // screen too, so it never shows a stale cart. It comes back in onStart.
        inForeground = false
        dismissPresentation()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        enterImmersive()
        mainWebView.onResume()
        maybePromptOverlayPermission()
        refreshPresentation()
    }

    override fun onPause() {
        mainWebView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        (mainWebView.url ?: lastCashierUrl)?.takeIf { it.startsWith("http") }
            ?.let { outState.putString(STATE_CASHIER_URL, it) }
    }

    override fun onDestroy() {
        displayManager.unregisterDisplayListener(displayListener)
        mainHandler.removeCallbacksAndMessages(null)
        urlDialog?.dismiss()
        urlDialog = null
        dismissPresentation()
        printerBridge?.destroy()
        printerBridge = null
        destroyWebView(mainWebView)
        super.onDestroy()
    }

    // ---------------------------------------------------------------- hotspot

    /** Counts taps in the top-left corner without consuming them, so the web UI still works. */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            val size = HOTSPOT_DP * resources.displayMetrics.density
            if (ev.x <= size && ev.y <= size) {
                val now = SystemClock.uptimeMillis()
                if (now - hotspotFirstTapAt > HOTSPOT_WINDOW_MS) {
                    hotspotFirstTapAt = now
                    hotspotTapCount = 0
                }
                hotspotTapCount++
                if (hotspotTapCount >= HOTSPOT_TAPS) {
                    hotspotTapCount = 0
                    hotspotFirstTapAt = 0
                    showUrlDialog()
                }
            } else {
                hotspotTapCount = 0
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun showUrlDialog() {
        if (urlDialog?.isShowing == true) return
        val pad = (20 * resources.displayMetrics.density).toInt()

        fun label(text: String) = TextView(this).apply { this.text = text }
        fun field(value: String) = EditText(this).apply {
            setText(value)
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSelectAllOnFocus(true)
        }

        val mainField = field(mainUrl())
        val customerField = field(customerUrl()).apply {
            hint = "Blank = the cashier's store second screen"
        }
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(label("Cashier screen URL (main_url)"))
            addView(mainField)
            addView(label("Customer screen URL (customer_url)"))
            addView(customerField)
            addView(label("Customer screen now: ${effectiveCustomerUrl().ifBlank { "(black until a store opens)" }}"))
            addView(label("Customer displays found: ${presentationDisplays().size}"))
        }

        urlDialog = AlertDialog.Builder(this)
            .setTitle("Screen URLs")
            .setView(form)
            .setPositiveButton("Save & reload") { _, _ ->
                prefs.edit()
                    .putString(PREF_MAIN_URL, normalizeUrl(mainField.text.toString()))
                    .putString(PREF_CUSTOMER_URL, normalizeUrl(customerField.text.toString()))
                    .apply()
                reloadBothScreens()
            }
            .setNeutralButton("Reload") { _, _ -> reloadBothScreens() }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { enterImmersive(); urlDialog = null }
            .show()
    }

    private fun reloadBothScreens() {
        mainWebView.loadUrl(mainUrl())
        val presentation = customerPresentation
        if (presentation != null) presentation.load(effectiveCustomerUrl()) else refreshPresentation()
    }

    /**
     * With customer_url blank, the rear screen follows the cashier: once the main WebView is on
     * /store/<id>/…, the customer screen loads that store's /store/<id>/second-screen page
     * (myenterprisex SecondScreenPage, fed by the cashier tab through shared localStorage).
     */
    private fun onCashierUrlChanged(url: String) {
        if (url.startsWith("http")) lastCashierUrl = url
        val derived = secondScreenUrlFor(url) ?: return
        if (derived == autoCustomerUrl) return
        autoCustomerUrl = derived
        if (customerUrl().isBlank()) customerPresentation?.load(derived)
    }

    private fun effectiveCustomerUrl(): String = customerUrl().ifBlank { autoCustomerUrl.orEmpty() }

    // ---------------------------------------------------------------- customer display

    private fun presentationDisplays(): Array<Display> =
        displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)

    /** Shows, moves or removes the customer Presentation to match the connected displays. */
    private fun refreshPresentation() {
        if (isFinishing || isDestroyed) return
        if (!inForeground) {
            dismissPresentation()
            return
        }
        val target = presentationDisplays().firstOrNull()
        val current = customerPresentation

        if (target == null) {
            dismissPresentation()
            return
        }
        if (current != null && current.isShowing && current.display.displayId == target.displayId) {
            return
        }
        dismissPresentation()
        customerPresentation = showPresentation(target)
    }

    private fun showPresentation(display: Display): CustomerPresentation? {
        // With "Display over other apps" granted, the overlay window type is more reliable on
        // Rockchip firmware. (It is still closed whenever the cashier leaves the app.) Fall back to a plain
        // Presentation if the firmware rejects the overlay type.
        val useOverlay = Settings.canDrawOverlays(this)
        return try {
            CustomerPresentation(this, display, useOverlay).also { it.show() }
        } catch (e: WindowManager.InvalidDisplayException) {
            Log.w(TAG, "Customer display ${display.displayId} went away", e)
            null
        } catch (e: RuntimeException) {
            if (!useOverlay) {
                Log.e(TAG, "Could not show customer display", e)
                null
            } else {
                Log.w(TAG, "Overlay presentation rejected, retrying as plain presentation", e)
                try {
                    CustomerPresentation(this, display, false).also { it.show() }
                } catch (e2: RuntimeException) {
                    Log.e(TAG, "Could not show customer display", e2)
                    null
                }
            }
        }
    }

    private fun dismissPresentation() {
        customerPresentation?.let {
            try {
                it.dismiss()
            } catch (e: RuntimeException) {
                Log.w(TAG, "Dismiss failed", e)
            }
        }
        customerPresentation = null
    }

    private inner class CustomerPresentation(
        outer: Context,
        display: Display,
        private val asOverlay: Boolean,
    ) : Presentation(outer, display) {

        var webView: WebView? = null
            private set

        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            window?.apply {
                if (asOverlay) setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
                addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                setBackgroundDrawableResource(android.R.color.black)
            }
            // Build the WebView with the Presentation's context so it gets the
            // customer screen's size and density, not the cashier screen's.
            val view = createWebView(context, customerScreen = true, onGone = {
                // The page's renderer died: start the customer screen over instead of a white screen.
                mainHandler.post {
                    if (customerPresentation === this@CustomerPresentation) {
                        dismissPresentation()
                        refreshPresentation()
                    }
                }
            })
            webView = view
            setContentView(view)
            window?.let { hideSystemBars(it, view) }
            load(effectiveCustomerUrl())
        }

        fun load(url: String) {
            val view = webView ?: return
            if (url.isBlank()) {
                // No customer URL yet: show black instead of mirroring the cashier screen.
                view.loadDataWithBaseURL(null, BLANK_PAGE, "text/html", "utf-8", null)
            } else {
                view.loadUrl(url)
            }
        }

        override fun onStop() {
            webView?.let { destroyWebView(it) }
            webView = null
            super.onStop()
        }
    }

    // ---------------------------------------------------------------- overlay permission

    private fun maybePromptOverlayPermission() {
        if (overlayPromptShown || Settings.canDrawOverlays(this)) return
        if (prefs.getBoolean(PREF_OVERLAY_DECLINED, false)) return
        overlayPromptShown = true
        AlertDialog.Builder(this)
            .setTitle("Allow customer display")
            .setMessage(
                "To keep the customer screen showing reliably, turn on " +
                    "\"Display over other apps\" for ${getString(R.string.app_name)}."
            )
            .setPositiveButton("Open settings") { _, _ ->
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName"),
                )
                try {
                    startActivity(intent)
                } catch (e: ActivityNotFoundException) {
                    Log.w(TAG, "No overlay settings screen on this firmware", e)
                }
            }
            .setNegativeButton("Not now", null)
            .setNeutralButton("Don't ask again") { _, _ ->
                prefs.edit().putBoolean(PREF_OVERLAY_DECLINED, true).apply()
            }
            .setOnDismissListener { enterImmersive() }
            .show()
    }

    // ---------------------------------------------------------------- WebView setup

    private fun createCashierWebView(): WebView =
        createWebView(this, onGone = { mainHandler.post { recoverCashier() } }) { url -> onCashierUrlChanged(url) }

    /**
     * The cashier page's renderer died (crash, or Android reclaimed it while the app was in the
     * background). Without this the WebView stays white, or the whole app is killed. Build a
     * fresh WebView and reopen the page the cashier was on; the POS keeps its own offline data.
     */
    private fun recoverCashier() {
        if (isFinishing || isDestroyed) return
        val url = lastCashierUrl ?: mainUrl()
        Log.w(TAG, "Cashier page stopped; reopening $url")
        val old = mainWebView
        mainWebView = createCashierWebView()
        printerBridge?.attach(mainWebView)
        setContentView(mainWebView)
        enterImmersive()
        destroyWebView(old)
        mainWebView.loadUrl(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(
        context: Context,
        customerScreen: Boolean = false,
        onGone: (() -> Unit)? = null,
        onUrlChanged: ((String) -> Unit)? = null,
    ): WebView = WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setBackgroundColor(Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true

        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            javaScriptCanOpenWindowsAutomatically = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        val webView = this
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webChromeClient = WebChromeClient()
        webViewClient = object : WebViewClient() {
            // Fires for full loads and SPA pushState navigations alike.
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                if (url != null) onUrlChanged?.invoke(url)
            }

            // First start with no internet: nothing of the POS is saved yet, so say so and
            // retry by itself. Once it has loaded once, the web app's own offline copy opens.
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(view, request, error)
                val url = request.url?.toString() ?: return
                if (!request.isForMainFrame || !url.startsWith("http")) return
                Log.w(TAG, "Could not load $url: ${error.errorCode} ${error.description}")
                view.loadDataWithBaseURL(null, offlinePageHtml(url, customerScreen), "text/html", "utf-8", null)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView renderer gone (crashed=${detail.didCrash()}, customer=$customerScreen)")
                val recover = onGone ?: return false
                recover()
                return true
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return when (uri.scheme?.lowercase()) {
                    "http", "https", "about", "data", "blob", "javascript" -> false
                    else -> {
                        // tel:, mailto:, intent: etc. go to the matching Android app.
                        try {
                            view.context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                        } catch (e: ActivityNotFoundException) {
                            Log.w(TAG, "No app for $uri", e)
                        }
                        true
                    }
                }
            }
        }
    }

    private fun destroyWebView(view: WebView) {
        (view.parent as? ViewGroup)?.removeView(view)
        view.stopLoading()
        view.webChromeClient = null
        view.destroy()
    }

    // ---------------------------------------------------------------- helpers

    private fun enterImmersive() = hideSystemBars(window, window.decorView)

    private fun hideSystemBars(window: android.view.Window, view: android.view.View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, view).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun mainUrl(): String =
        prefs.getString(PREF_MAIN_URL, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_MAIN_URL

    private fun customerUrl(): String = prefs.getString(PREF_CUSTOMER_URL, null) ?: DEFAULT_CUSTOMER_URL

    companion object {
        private const val TAG = "DualScreen"

        const val PREFS_NAME = "dual_screen"
        const val PREF_MAIN_URL = "main_url"
        const val PREF_CUSTOMER_URL = "customer_url"
        private const val PREF_OVERLAY_DECLINED = "overlay_prompt_declined"

        const val DEFAULT_MAIN_URL = "https://system.caltiger.ai"
        /** Empty = follow the cashier's store (see [secondScreenUrlFor]). */
        const val DEFAULT_CUSTOMER_URL = ""

        private val STORE_PATH = Regex("^(https?://[^/?#]+)/store/([^/?#]+)")

        /**
         * "https://system.caltiger.ai/store/abc/pos?x=1" → "https://system.caltiger.ai/store/abc/second-screen".
         * Null when the cashier isn't inside a store yet (sign-in page, store picker).
         */
        fun secondScreenUrlFor(url: String): String? {
            val m = STORE_PATH.find(url) ?: return null
            return "${m.groupValues[1]}/store/${m.groupValues[2]}/second-screen"
        }

        private const val HOTSPOT_DP = 80
        private const val HOTSPOT_TAPS = 5
        private const val HOTSPOT_WINDOW_MS = 3_000L

        private const val STATE_CASHIER_URL = "cashier_url"
        private const val BLANK_PAGE = "<html><body style=\"margin:0;background:#000\"></body></html>"

        /** A JS string literal that is also safe inside an HTML <script>. */
        fun jsString(s: String): String = buildString {
            append('"')
            for (c in s) {
                if (c.isLetterOrDigit() && c.code < 128 || c in ":/.?=-_~#%+,;@!*()[]$") append(c)
                else append("\\u%04x".format(c.code))
            }
            append('"')
        }

        /**
         * Shown when the POS can't load and nothing is saved on the terminal yet. It opens
         * [url] by itself once the connection is back. The customer screen gets a quiet line.
         */
        fun offlinePageHtml(url: String, customerScreen: Boolean): String {
            val body = if (customerScreen) {
                "<h1 class=\"quiet\">Waiting for the internet…</h1>"
            } else {
                "<h1>Please connect to the internet</h1>" +
                    "<p>Ultra POS needs the internet once to download your store's data. " +
                    "After that it keeps working even when the internet is down.</p>" +
                    "<p>Check the Wi-Fi or network cable. This screen opens the POS by itself " +
                    "as soon as the connection is back.</p>" +
                    "<button onclick=\"retry()\">Try again</button>"
            }
            return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#0b0b0c;color:#f2f2f2;font:16px/1.5 sans-serif}
.w{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
.c{max-width:520px}h1{font-size:24px;margin:0 0 12px}p{margin:0 0 12px;color:#c9c9cc}
h1.quiet{font-size:18px;font-weight:400;color:#8a8a8e}
button{margin-top:12px;font:inherit;font-weight:600;padding:12px 28px;min-height:48px;border-radius:8px;border:0;background:#2563eb;color:#fff}
</style></head><body><div class="w"><div class="c">$body</div></div>
<script>
var target=${jsString(url)};
function retry(){location.replace(target);}
window.addEventListener('online',function(){setTimeout(retry,1000);});
setInterval(function(){if(navigator.onLine)retry();},15000);
</script></body></html>"""
        }

        /**
         * Adds a scheme when someone pastes a bare host: https:// for "system.caltiger.ai",
         * http:// for local dev hosts like "192.168.1.20:5173" or "localhost:5173".
         */
        fun normalizeUrl(raw: String): String {
            val url = raw.trim()
            if (url.isEmpty() || url.contains("://") || url.startsWith("about:") || url.startsWith("data:")) {
                return url
            }
            val host = url.substringBefore('/').substringBefore(':')
            val isLocal = host == "localhost" ||
                Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host) ||
                host.endsWith(".local")
            return (if (isLocal) "http://" else "https://") + url
        }
    }
}
