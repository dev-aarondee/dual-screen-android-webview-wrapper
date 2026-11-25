package com.pos.dualscreen

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Printing for the web app, since Android WebView has no Web Bluetooth or WebUSB.
 *
 * The page calls `UltraPOSNative.call(id, method, argsJson)`; the answer comes back as
 * `window.__ultraposNative.resolve(id, ok, resultJson)`. Device events (a USB printer
 * unplugged) arrive as `window.__ultraposNative.event(name, dataJson)`.
 *
 * Methods (all bytes are base64):
 *  - `info`                                  → {usb, bluetooth, bluetoothOn, version}
 *  - `usb.connect` {key?, prompt?}           → {key, name, opened}; no key = pick from a list
 *  - `usb.write`   {key, data}               → {} (asks for USB permission if needed)
 *  - `usb.close`   {key}
 *  - `bt.connect`  {address?}                → {address, name}; no address = pick a paired printer
 *  - `bt.write`    {address, data}           → {} (reconnects once if the link dropped)
 *  - `bt.close`    {address}
 *
 * Errors reject with {code, message}; codes match the web app's PrinterConnectErrorCode
 * (cancelled, adapter-off, denied, no-endpoint, unreachable).
 *
 * Only the cashier WebView gets this, and only pages on the cashier URL's origin may use it.
 */
class NativePrinterBridge(
    private val activity: ComponentActivity,
    private val allowedOrigin: () -> String,
) {
    private var webView: WebView? = null
    private val main = Handler(Looper.getMainLooper())
    /** All device I/O runs here, one job at a time, so writes never interleave. */
    private val io = Executors.newSingleThreadExecutor()

    private val usbManager: UsbManager? = activity.getSystemService(UsbManager::class.java)
    private val btAdapter: BluetoothAdapter? =
        activity.getSystemService(BluetoothManager::class.java)?.adapter

    // Touched only on the io thread.
    private val usbLinks = HashMap<String, UsbLink>()
    private val btLinks = HashMap<String, BluetoothSocket>()

    // Touched only on the main thread.
    private val usbPermissionWaiters = HashMap<String, MutableList<(Boolean) -> Unit>>()
    private val btPermissionWaiters = mutableListOf<(Boolean) -> Unit>()

    private val btPermissionLauncher =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val waiters = btPermissionWaiters.toList()
            btPermissionWaiters.clear()
            waiters.forEach { it(granted) }
        }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device = usbDeviceExtra(intent) ?: return
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    usbPermissionWaiters.remove(device.deviceName)?.forEach { it(granted) }
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> io.execute {
                    val gone = usbLinks.entries.filter { it.value.device.deviceName == device.deviceName }
                    gone.forEach { (key, link) ->
                        link.close()
                        usbLinks.remove(key)
                        emit("usb-detached", JSONObject().put("key", key))
                    }
                }
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(activity, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun attach(view: WebView) {
        webView = view
        view.addJavascriptInterface(this, JS_NAME)
    }

    fun destroy() {
        try {
            activity.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
        }
        webView = null
        io.execute {
            usbLinks.values.forEach { it.close() }
            usbLinks.clear()
            btLinks.values.forEach { closeQuietly(it) }
            btLinks.clear()
        }
        io.shutdown()
    }

    // ---------------------------------------------------------------- JS entry point

    @JavascriptInterface
    fun call(id: String, method: String, argsJson: String?) {
        main.post {
            val view = webView ?: return@post
            if (!PrinterKeys.sameOrigin(view.url, allowedOrigin())) {
                reply(id, false, error("denied", "Printing is only available to the cashier site."))
                return@post
            }
            val args = try {
                if (argsJson.isNullOrBlank()) JSONObject() else JSONObject(argsJson)
            } catch (e: Exception) {
                reply(id, false, error("unreachable", "Bad arguments: ${e.message}"))
                return@post
            }
            val done = Reply(id)
            try {
                when (method) {
                    "info" -> done.ok(info())
                    "usb.connect" -> usbConnect(args, done)
                    "usb.write" -> usbWrite(args, done)
                    "usb.close" -> io.execute {
                        usbLinks.remove(args.optString("key"))?.close()
                        done.ok(JSONObject())
                    }
                    "bt.connect" -> btConnect(args, done)
                    "bt.write" -> btWrite(args, done)
                    "bt.close" -> io.execute {
                        btLinks.remove(args.optString("address"))?.let { closeQuietly(it) }
                        done.ok(JSONObject())
                    }
                    else -> done.fail("unreachable", "Unknown printer method $method")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Printer call $method failed", e)
                done.fail("unreachable", e.message ?: e.toString())
            }
        }
    }

    private fun info() = JSONObject()
        .put("usb", usbManager != null)
        .put("bluetooth", btAdapter != null)
        .put("bluetoothOn", btAdapter?.isEnabled == true)
        .put("version", BuildConfig.VERSION_NAME)

    // ---------------------------------------------------------------- USB

    private class UsbLink(
        val device: UsbDevice,
        val connection: UsbDeviceConnection,
        val iface: UsbInterface,
        val endpoint: UsbEndpoint,
    ) {
        fun close() {
            try {
                connection.releaseInterface(iface)
            } catch (_: Exception) {
            }
            connection.close()
        }
    }

    /** USB devices with a bulk OUT endpoint: every ESC/POS printer, including the built-in one. */
    private fun printableUsbDevices(): List<UsbDevice> =
        usbManager?.deviceList?.values?.filter { findBulkOut(it) != null }.orEmpty()

    private fun usbKey(d: UsbDevice): String = PrinterKeys.usbKey(
        d.vendorId, d.productId,
        if (usbManager?.hasPermission(d) == true) safe { d.serialNumber } else null,
    )

    private fun usbName(d: UsbDevice): String =
        listOfNotNull(safe { d.manufacturerName }, safe { d.productName })
            .joinToString(" ").trim()
            .ifEmpty { "USB printer %04X:%04X".format(d.vendorId, d.productId) }

    private fun findUsb(key: String): UsbDevice? = printableUsbDevices().firstOrNull {
        PrinterKeys.usbMatches(key, it.vendorId, it.productId,
            if (usbManager?.hasPermission(it) == true) safe { it.serialNumber } else null)
    }

    private fun usbConnect(args: JSONObject, done: Reply) {
        val manager = usbManager ?: return done.fail("unsupported", "This device has no USB host support.")
        val key = args.optString("key").takeIf { it.isNotBlank() }
        val prompt = args.optBoolean("prompt", true)

        val proceed = { device: UsbDevice ->
            if (!manager.hasPermission(device) && !prompt) {
                // Silent reconnect on page load: the printer is there, permission waits for the first print.
                done.ok(JSONObject().put("key", key ?: usbKey(device)).put("name", usbName(device)).put("opened", false))
            } else {
                withUsbPermission(device) { granted ->
                    if (!granted) return@withUsbPermission done.fail("denied", "USB permission was not allowed for this printer.")
                    io.execute {
                        try {
                            val k = usbKey(device)
                            openUsb(k, device)
                            done.ok(JSONObject().put("key", k).put("name", usbName(device)).put("opened", true))
                        } catch (e: PrinterException) {
                            done.fail(e.code, e.message)
                        }
                    }
                }
            }
        }

        if (key != null) {
            val device = findUsb(key) ?: return done.fail("unreachable", "The USB printer isn't plugged in or is turned off.")
            proceed(device)
            return
        }
        val devices = printableUsbDevices()
        if (devices.isEmpty()) {
            return done.fail("no-endpoint", "No USB printer found. Check it's plugged in and turned on.")
        }
        choose("Choose a USB printer", devices.map { usbName(it) }, done) { proceed(devices[it]) }
    }

    private fun usbWrite(args: JSONObject, done: Reply) {
        val key = args.optString("key")
        val bytes = decode(args, done) ?: return
        io.execute {
            val link = usbLinks[key]
            if (link != null) return@execute writeUsb(key, link, bytes, done)
            // Not open yet (first print since launch): find it, ask permission if needed, open.
            main.post {
                val device = findUsb(key) ?: return@post done.fail("unreachable", "The USB printer isn't plugged in or is turned off.")
                withUsbPermission(device) { granted ->
                    if (!granted) return@withUsbPermission done.fail("denied", "USB permission was not allowed for this printer.")
                    io.execute {
                        try {
                            writeUsb(key, openUsb(key, device), bytes, done)
                        } catch (e: PrinterException) {
                            done.fail(e.code, e.message)
                        }
                    }
                }
            }
        }
    }

    /** io thread */
    private fun writeUsb(key: String, link: UsbLink, bytes: ByteArray, done: Reply) {
        for ((start, end) in PrinterKeys.chunks(bytes.size, USB_CHUNK)) {
            val sent = link.connection.bulkTransfer(link.endpoint, bytes, start, end - start, USB_TIMEOUT_MS)
            if (sent < 0) {
                link.close()
                usbLinks.remove(key)
                return done.fail("unreachable", "The USB printer stopped answering. Check it's on and has paper.")
            }
        }
        done.ok(JSONObject())
    }

    /** io thread */
    private fun openUsb(key: String, device: UsbDevice): UsbLink {
        usbLinks.remove(key)?.close()
        val manager = usbManager ?: throw PrinterException("unsupported", "No USB host support.")
        val (iface, endpoint) = findBulkOut(device)
            ?: throw PrinterException("no-endpoint", "This USB device has no printer output.")
        val connection = manager.openDevice(device)
            ?: throw PrinterException("unreachable", "Android couldn't open the USB printer.")
        if (!connection.claimInterface(iface, true)) {
            connection.close()
            throw PrinterException("no-endpoint", "Another app is holding the USB printer.")
        }
        return UsbLink(device, connection, iface, endpoint).also { usbLinks[key] = it }
    }

    private fun findBulkOut(d: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
        // Prefer the printer-class interface, then any interface with a bulk OUT endpoint.
        val ifaces = (0 until d.interfaceCount).map { d.getInterface(it) }
            .sortedByDescending { it.interfaceClass == UsbConstants.USB_CLASS_PRINTER }
        for (iface in ifaces) {
            for (i in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(i)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) {
                    return iface to ep
                }
            }
        }
        return null
    }

    /** main thread */
    private fun withUsbPermission(device: UsbDevice, then: (Boolean) -> Unit) {
        val manager = usbManager ?: return then(false)
        if (manager.hasPermission(device)) return then(true)
        val waiters = usbPermissionWaiters.getOrPut(device.deviceName) { mutableListOf() }
        waiters += then
        if (waiters.size > 1) return // a request for this device is already on screen
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(activity.packageName)
        manager.requestPermission(device, PendingIntent.getBroadcast(activity, device.deviceId, intent, flags))
    }

    // ---------------------------------------------------------------- Bluetooth (classic SPP)

    @SuppressLint("MissingPermission") // checked by withBtPermission
    private fun btConnect(args: JSONObject, done: Reply) {
        val adapter = btAdapter ?: return done.fail("adapter-off", "This device has no Bluetooth.")
        val address = args.optString("address").takeIf { it.isNotBlank() }
        withBtPermission { granted ->
            if (!granted) return@withBtPermission done.fail("denied", "Bluetooth permission was not allowed.")
            if (!adapter.isEnabled) return@withBtPermission done.fail("adapter-off", "Bluetooth is off. Turn it on in Android settings.")

            val connect = { device: BluetoothDevice ->
                io.execute {
                    try {
                        openBt(device)
                        done.ok(JSONObject().put("address", device.address).put("name", btName(device)))
                    } catch (e: PrinterException) {
                        done.fail(e.code, e.message)
                    }
                }
            }
            if (address != null) {
                val device = try {
                    adapter.getRemoteDevice(address)
                } catch (e: IllegalArgumentException) {
                    return@withBtPermission done.fail("unreachable", "Bad Bluetooth address $address")
                }
                return@withBtPermission connect(device)
            }
            val paired = adapter.bondedDevices.orEmpty()
                .sortedByDescending { PrinterKeys.looksLikePrinter(btName(it), it.bluetoothClass?.majorDeviceClass) }
            if (paired.isEmpty()) {
                return@withBtPermission done.fail(
                    "cancelled",
                    "No paired Bluetooth printers. Pair the printer in Android Settings → Bluetooth first, then connect again.",
                )
            }
            choose("Choose a Bluetooth printer", paired.map { "${btName(it)}  (${it.address})" }, done) { connect(paired[it]) }
        }
    }

    private fun btWrite(args: JSONObject, done: Reply) {
        val address = args.optString("address")
        val bytes = decode(args, done) ?: return
        val adapter = btAdapter ?: return done.fail("adapter-off", "This device has no Bluetooth.")
        withBtPermission { granted ->
            if (!granted) return@withBtPermission done.fail("denied", "Bluetooth permission was not allowed.")
            io.execute {
                try {
                    val device = adapter.getRemoteDevice(address)
                    var socket = btLinks[address] ?: openBt(device)
                    try {
                        socket.outputStream.write(bytes)
                        socket.outputStream.flush()
                    } catch (e: IOException) {
                        // Link dropped since the last print (printer slept): reconnect once, send again.
                        socket = openBt(device)
                        socket.outputStream.write(bytes)
                        socket.outputStream.flush()
                    }
                    done.ok(JSONObject())
                } catch (e: PrinterException) {
                    done.fail(e.code, e.message)
                } catch (e: Exception) {
                    btLinks.remove(address)?.let { closeQuietly(it) }
                    done.fail("unreachable", "Couldn't send to the Bluetooth printer: ${e.message}")
                }
            }
        }
    }

    /** io thread */
    @SuppressLint("MissingPermission")
    private fun openBt(device: BluetoothDevice): BluetoothSocket {
        btLinks.remove(device.address)?.let { closeQuietly(it) }
        try {
            btAdapter?.cancelDiscovery()
        } catch (_: SecurityException) {
        }
        var last: Exception? = null
        // Secure first; many cheap printers only accept the insecure RFCOMM socket.
        for (insecure in listOf(false, true)) {
            val socket = try {
                if (insecure) device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                else device.createRfcommSocketToServiceRecord(SPP_UUID)
            } catch (e: Exception) {
                last = e
                continue
            }
            try {
                socket.connect()
                btLinks[device.address] = socket
                return socket
            } catch (e: Exception) {
                last = e
                closeQuietly(socket)
            }
        }
        throw PrinterException(
            "unreachable",
            "Couldn't reach ${btName(device)}. Make sure it's on and nearby. (${last?.message})",
        )
    }

    @SuppressLint("MissingPermission")
    private fun btName(d: BluetoothDevice): String = safe { d.name }?.takeIf { it.isNotBlank() } ?: d.address

    /** main thread */
    private fun withBtPermission(then: (Boolean) -> Unit) {
        // Android 11 grants Bluetooth at install; 12+ asks at run time.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return then(true)
        val perm = Manifest.permission.BLUETOOTH_CONNECT
        if (ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED) return then(true)
        btPermissionWaiters += then
        if (btPermissionWaiters.size == 1) btPermissionLauncher.launch(perm)
    }

    // ---------------------------------------------------------------- plumbing

    private class PrinterException(val code: String, override val message: String) : Exception(message)

    private inner class Reply(private val id: String) {
        fun ok(result: JSONObject) = reply(id, true, result)
        fun fail(code: String, message: String) = reply(id, false, error(code, message))
    }

    private fun error(code: String, message: String) = JSONObject().put("code", code).put("message", message)

    /** Any thread. */
    private fun reply(id: String, ok: Boolean, payload: JSONObject) = js(
        "window.__ultraposNative&&window.__ultraposNative.resolve(" +
            "${JSONObject.quote(id)},$ok,${JSONObject.quote(payload.toString())})",
    )

    private fun emit(name: String, data: JSONObject) = js(
        "window.__ultraposNative&&window.__ultraposNative.event&&window.__ultraposNative.event(" +
            "${JSONObject.quote(name)},${JSONObject.quote(data.toString())})",
    )

    private fun js(script: String) {
        main.post { webView?.evaluateJavascript(script, null) }
    }

    private fun decode(args: JSONObject, done: Reply): ByteArray? = try {
        Base64.decode(args.getString("data"), Base64.DEFAULT)
    } catch (e: Exception) {
        done.fail("unreachable", "Bad print data: ${e.message}")
        null
    }

    /** main thread: a plain list dialog; closing it rejects with "cancelled" like the browser picker. */
    private fun choose(title: String, items: List<String>, done: Reply, picked: (Int) -> Unit) {
        var chosen = false
        AlertDialog.Builder(activity)
            .setTitle(title)
            .setItems(items.toTypedArray()) { _, which ->
                chosen = true
                picked(which)
            }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!chosen) done.fail("cancelled", "No printer chosen.") }
            .show()
    }

    @Suppress("DEPRECATION")
    private fun usbDeviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    private fun closeQuietly(socket: BluetoothSocket) {
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }

    private inline fun <T> safe(block: () -> T?): T? = try {
        block()
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val TAG = "UltraPOSPrinter"
        const val JS_NAME = "UltraPOSNative"
        private const val ACTION_USB_PERMISSION = "com.pos.dualscreen.USB_PERMISSION"
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val USB_CHUNK = 16 * 1024
        private const val USB_TIMEOUT_MS = 5_000
    }
}

/** Pure helpers, unit tested. */
object PrinterKeys {
    /** "vid:pid:serial" (serial blank when Android hides it until permission is granted). */
    fun usbKey(vendorId: Int, productId: Int, serial: String?): String = "$vendorId:$productId:${serial.orEmpty()}"

    /** Same vendor and product; serials compared only when both sides know one. */
    fun usbMatches(key: String, vendorId: Int, productId: Int, serial: String?): Boolean {
        val parts = key.split(':')
        if (parts.size < 2) return false
        if (parts[0].toIntOrNull() != vendorId || parts[1].toIntOrNull() != productId) return false
        val stored = parts.getOrNull(2).orEmpty()
        return stored.isEmpty() || serial.isNullOrEmpty() || stored == serial
    }

    /** [start, end) ranges of at most [size] bytes. */
    fun chunks(total: Int, size: Int): List<Pair<Int, Int>> =
        (0 until total step size).map { it to minOf(it + size, total) }

    fun origin(url: String?): String? {
        val m = Regex("^(https?)://([^/?#]+)", RegexOption.IGNORE_CASE).find(url ?: return null) ?: return null
        return "${m.groupValues[1].lowercase()}://${m.groupValues[2].lowercase()}"
    }

    fun sameOrigin(pageUrl: String?, allowedUrl: String): Boolean {
        val page = origin(pageUrl) ?: return false
        return page == origin(allowedUrl)
    }

    /** Sort hint only: printers first in the paired list. 0x0600 = imaging (printers). */
    fun looksLikePrinter(name: String, majorClass: Int?): Boolean =
        majorClass == 0x0600 || Regex("print|pos|rpp|mpt|xp-|pt-|thermal", RegexOption.IGNORE_CASE).containsMatchIn(name)
}
