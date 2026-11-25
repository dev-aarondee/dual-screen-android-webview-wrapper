package com.pos.dualscreen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterKeysTest {
    @Test
    fun usbKeyMatchesWithOrWithoutSerial() {
        val key = PrinterKeys.usbKey(1155, 22304, "ABC123")
        assertEquals("1155:22304:ABC123", key)
        assertTrue(PrinterKeys.usbMatches(key, 1155, 22304, "ABC123"))
        // Before USB permission Android hides the serial: still the same printer.
        assertTrue(PrinterKeys.usbMatches(key, 1155, 22304, null))
        assertTrue(PrinterKeys.usbMatches("1155:22304:", 1155, 22304, "ABC123"))
        assertFalse(PrinterKeys.usbMatches(key, 1155, 22304, "OTHER"))
        assertFalse(PrinterKeys.usbMatches(key, 1155, 1, "ABC123"))
        assertFalse(PrinterKeys.usbMatches("garbage", 1155, 22304, null))
    }

    @Test
    fun chunksCoverEveryByteOnce() {
        assertEquals(emptyList<Pair<Int, Int>>(), PrinterKeys.chunks(0, 4))
        assertEquals(listOf(0 to 4, 4 to 8, 8 to 10), PrinterKeys.chunks(10, 4))
        assertEquals(listOf(0 to 4), PrinterKeys.chunks(4, 4))
    }

    @Test
    fun onlyTheCashierOriginMayPrint() {
        val allowed = "https://system.caltiger.ai"
        assertTrue(PrinterKeys.sameOrigin("https://system.caltiger.ai/store/abc/pos", allowed))
        assertTrue(PrinterKeys.sameOrigin("https://SYSTEM.caltiger.ai/x", "https://system.caltiger.ai/login"))
        assertFalse(PrinterKeys.sameOrigin("https://evil.example/system.caltiger.ai", allowed))
        assertFalse(PrinterKeys.sameOrigin("http://system.caltiger.ai/", allowed))
        assertFalse(PrinterKeys.sameOrigin(null, allowed))
        assertFalse(PrinterKeys.sameOrigin("about:blank", allowed))
        assertTrue(PrinterKeys.sameOrigin("http://192.168.1.20:5173/store/x", "http://192.168.1.20:5173"))
    }

    @Test
    fun printersSortFirst() {
        assertTrue(PrinterKeys.looksLikePrinter("RPP02N", null))
        assertTrue(PrinterKeys.looksLikePrinter("Headset", 0x0600))
        assertFalse(PrinterKeys.looksLikePrinter("Galaxy Buds", 0x0400))
    }
}
