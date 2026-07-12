# Together — Android app

This is a real Android Studio project, not a demo. It gives you what a browser
never can: **screen sharing that survives switching to Instagram**, using the
same native APIs Instagram/Zoom/Meet use (`MediaProjection` + a foreground
service), plus the real WebRTC Android SDK for the camera/mic call.

**Be honest with yourself about scope before diving in**: this is genuine
native app development. I've written every file to be structurally complete
and consistent, but I have no Android SDK or device in my environment to
actually compile or run it — so treat this as a strong, real starting point
that will need some hands-on debugging in Android Studio, not a finished
push-button app. If you know someone who's done Android dev before, this is
a good moment to loop them in.

## What this app does differently from the web version

- The **call + screen share** run natively (Kotlin + WebRTC Android SDK), so screen
  sharing keeps working even when you switch to Instagram/Spotify/anything else.
- The **chat, YouTube, Spotify, reactions, and movie-watching** features are
  the *same* web app you already have, loaded inside a WebView with
  `?native=1` — so you don't lose any of that, and any future updates to
  `client/` automatically show up here too.
- Both connect to the same `server/` backend you already deployed — no new backend needed.

## Before you start: what you need installed

1. **Android Studio** (free) — [developer.android.com/studio](https://developer.android.com/studio). This includes the Android SDK, emulator, and everything else.
2. A **physical Android phone** is strongly recommended for testing screen share (emulators can capture their own screen, but it's a much less reliable test than a real phone).
3. Your **server already deployed** (Railway, from before) — you'll type that URL into the app.

## Opening the project

1. Open Android Studio → **Open** → select the `android/` folder from this zip (the one containing `settings.gradle.kts`).
2. Let Gradle sync — the first sync will download the WebRTC SDK, Socket.IO client, and other dependencies, so it needs internet access and may take several minutes.
3. If Gradle sync fails on the WebRTC dependency version (`io.github.webrtc-sdk:android:125.6422.07`), check [github.com/webrtc-sdk/android/releases](https://github.com/webrtc-sdk/android/releases) for the current latest version tag and update it in `app/build.gradle.kts`.

## Running it

1. Plug in your Android phone (enable **Developer Options → USB debugging** first — search "how to enable USB debugging Android" if you haven't done this before).
2. Click the green **Run** button in Android Studio, select your phone.
3. On first launch: type your name, paste your deployed server URL (e.g. `https://ample-liberation-production-59de.up.railway.app`), leave room code blank to create a new one (or type the one your girlfriend's already in), tap **Start**.
4. Grant camera/mic permissions when asked.
5. To test screen sharing: tap the share icon, grant the screen-capture permission, then try switching to another app (like Instagram) — the notification bar should show "Sharing your screen" the whole time, and the call should keep running.

## Known rough edges to expect (things a developer picking this up should check first)

- **WebRTC SDK version drift**: WebRTC's Android SDK ships very frequent releases; the exact version pinned in `app/build.gradle.kts` may be superseded by the time you build this. If APIs like `ScreenCapturerAndroid` or `RTCConfiguration` have changed signatures, check that library's changelog.
- **Room code entry is manual for now**: right now you type the server URL and room code directly into the native app's start screen. A nicer version would let you tap an invite link (like the web version does) and have Android open the app directly to that room — this needs an Android "App Link" / deep link configuration, which isn't wired up yet.
- **Only one screen preview surface is reused for both local and remote screen share** — if you want to see your own shared screen thumbnail *and* your partner's screen at the same time, that needs a second `SurfaceViewRenderer` added.
- **No reconnect handling yet** if the call drops (e.g. brief network loss) — right now you'd need to restart the app to rejoin.
- **App icon is the default Android Studio placeholder** — you'll want to replace `app/src/main/res/mipmap-*` with your own icon before this feels like "your" app.

## Publishing to the Play Store (once it's working well for you two)

1. Create a **Google Play Console** account — $25 one-time fee.
2. In Android Studio: **Build → Generate Signed Bundle/APK** → follow the wizard to create a signing key (keep this file and its password safe forever — you need the *same* key for every future update).
3. Upload the generated `.aab` file to Play Console, fill in the store listing (screenshots, description, privacy policy — required even for a 2-person app), and submit for review.
4. Google's review typically takes anywhere from a few hours to a few days for a first submission.

If you'd rather skip the Play Store entirely and just install this directly on your two phones, you can build a debug APK (`Build → Build Bundle(s)/APK(s) → Build APK(s)`) and share the `.apk` file directly — no store, no review, just install it like any sideloaded app (you'll need to allow "install from unknown sources" once).
