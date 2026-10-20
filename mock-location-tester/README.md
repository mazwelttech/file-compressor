# Mock Location Tester

A small Android app for checking whether the location and geofence enforcement in **your own**
attendance app (check-in / check-out) can be fooled by a third-party mock-location app.

It uses the same public mechanism every "fake GPS" app on the Play Store uses: Android's
*mock location app* developer option, `LocationManager` test providers, and the Play services
fused mock mode. It does **not** hide the mock flag or use root/Xposed, so what your app sees here is
the baseline a casual user could produce. Only use it on apps and devices you are authorised to test.

## Get the APK

The APK is built by GitHub Actions (`.github/workflows/mock-location-tester.yml`):

1. Open the repo's **Actions** tab, pick the latest *Build Mock Location Tester APK* run.
2. Download the `mock-location-tester-debug-apk` artifact and unzip it to get `app-debug.apk`.
3. Copy it to the test phone and install (allow "install unknown apps" for your file manager/browser).

To build locally instead: install Android Studio (or the Android SDK + JDK 17), then
`cd mock-location-tester && ./gradlew assembleDebug`. The APK lands in `app/build/outputs/apk/debug/`.

## One-time device setup

1. Settings > About phone > tap **Build number** 7 times to enable Developer options.
2. Settings > System > Developer options > **Select mock location app** > *Mock Location Tester*.
   (The in-app "Open Developer options" button jumps there.)
3. Open the app, tap **Start / Apply**, and allow location (and notification) permission.

If step 2 is skipped the app shows an error instead of starting.

## Using it

- **Coordinates**: paste `lat, lng` straight from Google Maps (right-click > click the coordinates).
- **Accuracy / Jitter / Altitude**: reported accuracy radius, random per-second wobble, altitude.
- **Destination + speed**: leave empty to stay put; set both to walk from the start to the destination
  at that speed (km/h). Handy for crossing a geofence boundary.
- **Start / Apply** while already running *teleports* straight to the new coordinates. That is
  intentional: it simulates an impossible jump.
- **Presets**: save named locations (office gate, home, another city). Tap loads (and applies if
  running); long-press deletes.
- The status box shows, per provider, what other apps currently read from the system, including
  `isMock`. If that says `isMock=true`, your app can detect it too.

## Suggested test plan for the attendance app

Do each step with the attendance app in the foreground while Mock Location Tester runs in the background.

| # | Scenario | Expected from a well-defended app |
|---|----------|-----------------------------------|
| 1 | Mock **off**, standing at the office: check in | Succeeds (control) |
| 2 | Mock **on** at the office coordinates, while physically elsewhere: check in | Rejected, flagged as mock location |
| 3 | Mock on at a point outside the geofence: check in | Rejected as out of range |
| 4 | Check in with mock at the office, then **Apply** a city far away, then check out | Rejected or flagged as impossible travel |
| 5 | Mock at the office with accuracy 500 m | Rejected for poor accuracy |
| 6 | Walk (destination + speed) across the geofence edge | Check-in only allowed once inside |
| 7 | Start mocking, check in, **Stop**, check out | Handled sensibly when location reverts to the real one |
| 8 | Mock on, but force-close and reopen the attendance app | Still detected after a cold start |
| 9 | Replay the check-in API call with made-up coordinates (curl/Postman, no phone) | Server rejects it; it must not trust client-supplied coordinates alone |

Row 9 is usually the real weak point: any check that lives only inside the app can be bypassed by
calling the backend directly.

## What to look at if a test passes (i.e. the spoof worked)

- **Client**: read `Location.isMock()` (API 31+) / `isFromMockProvider()` on *every* location in the
  result, not just the last, and send the flag to the server. `Settings.Secure.ALLOW_MOCK_LOCATION`
  is no longer meaningful on Android 6+.
- **Server**: check the distance to the site server-side, and reject stale timestamps and poor
  accuracy. Compare consecutive punches for impossible speed, and cross-check coarse signals you
  already receive (IP geolocation, Wi-Fi BSSID/SSID, cell id).
- **Device integrity**: verify a Play Integrity token server-side to catch rooted or tampered devices.
  Treat client-side signals as hints, since a rooted device with a hooking framework can hide the
  mock flag, so also log and review anomalies instead of relying on one hard check.

## Project layout

```
app/src/main/java/dev/geotester/mocklocation/
  MainActivity.kt         UI (built in code, no layout XML or AndroidX)
  MockLocationService.kt  foreground service: publishes one location per second
  MockConfig.kt           validated settings, form model, presets storage
  Geo.kt                  distance / bearing / offset math, coordinate parsing
```
