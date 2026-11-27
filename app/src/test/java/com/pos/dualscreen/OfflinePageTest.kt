package com.pos.dualscreen

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflinePageTest {

    @Test
    fun cashierPageAsksToConnectAndRetriesTheSameUrl() {
        val html = MainActivity.offlinePageHtml("https://system.caltiger.ai/store/a/pos?x=1", customerScreen = false)
        assertTrue(html.contains("Please connect to the internet"))
        assertTrue(html.contains("download your store's data"))
        assertTrue(html.contains("var target=\"https://system.caltiger.ai/store/a/pos?x=1\";"))
        assertTrue(html.contains("Try again"))
    }

    @Test
    fun customerScreenStaysQuiet() {
        val html = MainActivity.offlinePageHtml("https://system.caltiger.ai/store/a/second-screen", customerScreen = true)
        assertTrue(html.contains("Waiting for the internet"))
        assertFalse(html.contains("Try again"))
    }

    @Test
    fun aUrlCannotBreakOutOfTheScript() {
        val html = MainActivity.offlinePageHtml("https://x.y/\"</script><script>alert(1)//", customerScreen = false)
        assertFalse(html.contains("</script><script>alert"))
        assertFalse(html.contains("\"</script>"))
    }
}
