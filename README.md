# dual-screen-android-webview-wrapper

A thin Android shell that runs the Ultra POS web app (myenterprisex) on the
**LogicOwl OJ-D3 Mini** (RK3568, Android 11–14), with a different web page on each screen:

| Screen | Android display | Shows |
|---|---|---|
| 10.1" cashier touchscreen | Display 0 | `main_url` (default `https://system.caltiger.ai`) |
| 4.5" rear customer screen | first `DISPLAY_CATEGORY_PRESENTATION` display | `customer_url` (default: empty, so the screen stays black) |

No web files are packed into the APK. Both screens load live URLs, so a web deploy
reaches the terminal without a new APK.

## What it does

- Two WebViews in one app process. Pages from the same origin share `localStorage`,
  IndexedDB, service workers and `BroadcastChannel`, so the cashier page can drive the customer page.
- The customer screen follows the hardware: it appears when the display connects and closes cleanly when it disconnects.
- Tap the **top-left corner (80×80 dp) 5 times within 3 seconds** to open the *Screen URLs*
  dialog. Paste new URLs and tap **Save & reload**. The URLs are saved in SharedPreferences and survive restarts.
  Typing a bare host is fine: `system.caltiger.ai` becomes `https://…`, and `192.168.1.20:5173` becomes `http://…`.
  The taps still reach the web page, so a menu button in that corner keeps working.
- Full screen with no status or navigation bars, and the screen stays on. Back goes back in WebView
  history and never closes the app.
- On first launch it asks for **Display over other apps**. With that permission on, the customer
  screen uses an overlay window, which is more reliable on Rockchip firmware. Without it, the app falls back to a normal `Presentation`.
- `http://` dev servers and mixed content are allowed for testing.

## Build the APK on GitHub (no Android Studio needed)

1. Push this repo to GitHub, for example:
   ```sh
   gh repo create dual-screen-android-webview-wrapper --private --source . --push
   ```
2. Every push runs **Actions → Build APK**. To run it by hand, open the
   **Actions** tab, pick **Build APK**, and click **Run workflow**.
3. When the run is green, open it and download **app-debug** under *Artifacts*.
   It is a zip that holds `app-debug.apk`.

To build locally instead, you need JDK 17 and the Android SDK (platform 34):
```sh
./gradlew assembleDebug   # → app/build/outputs/apk/debug/app-debug.apk
```

## Install on the POS terminal

**Option A: USB / adb**
1. On the terminal, open **Settings → About tablet** and tap **Build number** 7 times. Then go to
   **Settings → System → Developer options** and turn on **USB debugging**.
2. Connect it to a computer and run `adb install -r app-debug.apk`.

**Option B: no computer**
1. Copy `app-debug.apk` to a USB stick, or download it on the terminal.
2. Open it with the Files app. Allow **Install unknown apps** for that app when asked, then tap **Install**.

**First run**
1. Open **Ultra POS**. When asked, tap **Open settings** and turn on **Display over other apps**, then go back.
2. Tap the top-left corner 5 times and set the cashier URL and the customer URL.
3. Optional: in Android settings, set Ultra POS to start on boot or pin it (screen pinning or your MDM's kiosk mode).

## Troubleshooting

- **The customer screen mirrors the cashier screen.** The app found no presentation display. The URL
  dialog shows *Customer displays found: N*. If N is 0, check that the rear screen is turned on in the
  terminal's display settings, which on some firmware is under *Dual screen*.
- **Debugging pages.** Debug builds allow remote inspection. Connect over USB and open
  `chrome://inspect` in desktop Chrome to see both WebViews.
- **Reset URLs.** Clear the app's storage in Android settings to go back to the defaults.

## Project layout

```
.github/workflows/build.yml                       CI: JDK 17 + Gradle → app-debug artifact
settings.gradle.kts, build.gradle.kts             AGP 8.5.2, Kotlin 1.9.24, Gradle 8.7 wrapper
app/build.gradle.kts                              minSdk 30, target/compile 34
app/src/main/AndroidManifest.xml
app/src/main/java/com/pos/dualscreen/MainActivity.kt
```
