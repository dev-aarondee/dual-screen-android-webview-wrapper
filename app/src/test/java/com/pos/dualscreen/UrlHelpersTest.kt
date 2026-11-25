package com.pos.dualscreen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UrlHelpersTest {

    @Test
    fun secondScreenFollowsCashierStore() {
        assertEquals(
            "https://system.caltiger.ai/store/abc-123/second-screen",
            MainActivity.secondScreenUrlFor("https://system.caltiger.ai/store/abc-123/pos?tab=1#x"),
        )
        assertEquals(
            "http://192.168.1.20:5173/store/s1/second-screen",
            MainActivity.secondScreenUrlFor("http://192.168.1.20:5173/store/s1"),
        )
    }

    @Test
    fun noSecondScreenOutsideAStore() {
        assertNull(MainActivity.secondScreenUrlFor("https://system.caltiger.ai/"))
        assertNull(MainActivity.secondScreenUrlFor("https://system.caltiger.ai/login"))
        assertNull(MainActivity.secondScreenUrlFor("https://system.caltiger.ai/stores"))
    }

    @Test
    fun normalizeAddsTheRightScheme() {
        assertEquals("", MainActivity.normalizeUrl("  "))
        assertEquals("https://system.caltiger.ai", MainActivity.normalizeUrl(" system.caltiger.ai "))
        assertEquals("http://192.168.1.20:5173/x", MainActivity.normalizeUrl("192.168.1.20:5173/x"))
        assertEquals("http://localhost:5173", MainActivity.normalizeUrl("localhost:5173"))
        assertEquals("http://pos.local", MainActivity.normalizeUrl("pos.local"))
        assertEquals("http://x.test/a", MainActivity.normalizeUrl("http://x.test/a"))
        assertEquals("about:blank", MainActivity.normalizeUrl("about:blank"))
    }
}
