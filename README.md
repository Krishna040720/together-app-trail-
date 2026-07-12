# Together

A private, just-the-two-of-you app: video/voice call + perfectly synced video watching (YouTube or your own uploaded clips/reels) + chat + reactions — without screen-share lag or "wait, pause it" mismatches.

**Two ways to use this:**
- **`client/` + `server/`** — the browser web app, works on any device, no install needed.
- **`android/`** — a real native Android app that adds background-capable screen sharing (survives switching to Instagram, unlike the browser version) using the same native APIs Instagram/Zoom use. See `android/README-ANDROID.md` — this one's a genuine Android Studio project, more involved to set up than the web version.


## How it works

- **Call**: direct WebRTC connection between you two (peer-to-peer, so video/audio quality depends only on your two connections, not a server relaying it).
- **Sync**: instead of screen-sharing (which re-encodes video and causes lag/quality loss), each of you loads the *same source* — a YouTube link, or a video file one of you uploads — and the server just broadcasts "play / pause / seek" events so both players stay locked together within ~1 second.
- **Chat + reactions + moments**: run over the same lightweight realtime connection (Socket.io).

⚠️ **Important limitation**: this can't sync Netflix/Prime/Hotstar/Disney+ etc. Those platforms are DRM-locked to their own apps — there's no legal or stable way to pipe their video into a custom player. This app works great for YouTube and any video file either of you has (downloaded clips, phone recordings, exported reels, etc).

## Project structure

```
together-app/
  server/       Node.js + Express + Socket.io backend (signaling, sync, chat, uploads)
  client/       Plain HTML/CSS/JS frontend — no build step needed
```

## Run it locally

```bash
cd server
npm install
npm start
```

The server runs on `http://localhost:4000` and **also serves the client** automatically — so just open `http://localhost:4000` in two browser tabs (or send the link to your partner if you're on the same network / already deployed).

## Deploying so you two can actually use it remotely

**Simplest option — one deploy:**
1. Push this whole folder to a GitHub repo.
2. Deploy the `server/` folder to [Render](https://render.com) or [Railway](https://railway.app) (free tier works) — set the start command to `npm start`, root directory to `server`.
3. Because the server also serves `client/`, once it's live, the URL Render/Railway gives you (e.g. `https://together-yourname.onrender.com`) is the link you both open. Done.

**If you'd rather keep frontend/backend separate** (e.g. client on Netlify like your apology page, server on Render):
1. Deploy `server/` to Render/Railway as above — note its URL.
2. In `client/app.js`, set the config line at the top:
   ```js
   const SERVER_URL = "https://your-backend-url.onrender.com";
   ```
3. Deploy the `client/` folder to Netlify Drop, same as before.

## What's new in this version

- **Mobile screen share is now honest instead of confusing**: on iPhone/iPad, the screen share button is now disabled with an explanation (Apple simply doesn't let browsers do this — no workaround exists). On Android Chrome, if you switch to another app mid-share, the other person now sees a clear message ("switched apps — sharing is paused") and a dimmed frame instead of a silent black screen with no explanation.
- Previous updates (invite links, in-app YouTube search, screen-share audio, drift correction, clearer call tiles) are all still in — see below.

- **YouTube search built into the app** — no more copy/pasting links (optional link-paste is still there as a fallback). This needs a free YouTube Data API key from Google (the app will prompt you once and save it in your browser) — takes about 2 minutes to get one at [console.cloud.google.com](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
- **Screen share now includes sound**. In Chrome's share picker, choose the **"Chrome Tab"** option (not "Entire Screen") and tick **"Share tab audio"** — that's the combination that reliably sends sound to the other person. Sharing your entire desktop on macOS can't include system audio at all — that's a macOS restriction, not something any browser app can get around.
- **Drift correction** — YouTube, Spotify, and uploaded videos now quietly re-sync every few seconds in the background, not just when someone hits play/pause. This fixes the "starts together but slowly drifts out of sync" problem.
- Invite links, bigger clearer call tiles, and mic-muted badges (from the previous update) are all still in.

## Mobile limitations (platform restrictions, not app bugs)

- **iPhone/iPad**: screen sharing from any website is blocked by Apple at the OS level — Safari and every other iOS browser inherit this. The app now disables the button and explains this instead of letting you hit a confusing black screen.
- **Android Chrome**: screen sharing works, but only for that one browser tab — switching to another app (like Instagram or the Spotify app) freezes what the other person sees, because the tab goes into the background. The app now tells them plainly when this happens rather than leaving it a silent frozen frame.
- **Spotify's "Open in app?" prompt**: tapping play inside the embedded Spotify player on mobile can hand playback off to the actual Spotify app, which the browser (and this app's sync code) can no longer see or control. This is Spotify's own mobile behavior.
- **Bottom line for now**: call + YouTube/uploaded-video watching works well cross-device (phone-to-laptop, phone-to-phone). Screen share and Spotify are most reliable laptop-to-laptop for the moment.

## About Spotify specifically — an honest limitation

Spotify's embedded player (the one this app uses) only plays **full tracks** if the person viewing it is logged into Spotify in that browser **and** has Spotify Premium. Without that, Spotify itself limits playback to a 30-second preview — that's Spotify's own rule for anyone embedding their player anywhere on the web, not a bug in this app or something I can code around.

If you want proper full-track shared listening for both of you, the real fix is a **Spotify Login (OAuth) integration** using Spotify's official Web Playback SDK — this lets each of you log into your own Spotify Premium account inside the app and control playback for real, the same way Spotify Connect works. It's a legitimate, bigger feature to add (it needs you to register a free Spotify Developer app and give me a Client ID) — let me know if you want me to build that next.

Playlists specifically: the embed sometimes needs you to press play once *inside* the embedded player before the sync takes over — that's Spotify's playlist embed behaving differently from their track embed, not something adjustable from this app's side.

## What's new in this version

- **TURN server support, on by default** — the single biggest reliability upgrade for cross-network calls (different wifi networks, mobile data, strict/corporate NATs — STUN alone fails in exactly these cases). It now ships with [Open Relay Project](https://www.metered.ca/tools/openrelay/)'s free **public** TURN credentials pre-configured, so cross-network calls work out of the box with zero setup.
  - **Important honest caveat**: those public credentials are shared by everyone who's ever followed a WebRTC tutorial using them — they can occasionally be slow, rate-limited, or briefly down under load. For something you're actually relying on regularly, get your **own** free TURN credentials (same free tier, just your own quota) in about 2 minutes at [metered.ca/tools/openrelay](https://www.metered.ca/tools/openrelay/), then:
    - **On Render (or any host with environment variables)**: just add two environment variables to your service — `TURN_USERNAME` and `TURN_CREDENTIAL` — with the values from your Metered dashboard, then redeploy. No code editing needed; the server injects them into the client automatically via `/config.js`.
    - **Android app**: paste them into the `turnUsername` / `turnCredential` fields near the top of `RTCClient.kt`.
    - Your own credentials automatically override the shared public ones.
- **Connection recovery banner** — if a call genuinely can't connect after several automatic retry attempts (ICE restarts with backoff), instead of silently staying broken, you'll now see a banner with a **Retry** button so you have a clear next step instead of just refreshing blind.
- **Better default video/audio quality** — explicit HD constraints (720p/30fps) instead of browser defaults, explicit echo cancellation/noise suppression/auto-gain, and a raised bitrate ceiling (2.5 Mbps) so quality isn't left on the table on a decent connection.
- **Automatic reconnection** — if the connection drops (brief wifi hiccup, switching networks), the app now attempts an ICE restart automatically with backoff, instead of requiring you to refresh/rejoin.
- **Connection quality indicator** — the dot next to your room code now reflects real call health (checked every 5s via actual packet-loss/round-trip-time stats), not just "socket connected." Green = solid, red/pulsing = struggling and reconnecting.
- **Mobile autoplay fallback** — mobile browsers often block autoplaying the incoming call/screen-share video with sound (silently — no error, it just doesn't show). The app now detects this and shows a one-tap "🔊 Tap to hear/see them" button instead of leaving a blank video tile.

## An honest note on "make it as good as Zoom/Discord"

This app already uses the same core call technology (WebRTC) both of those use. For a 1-on-1 call, the above changes get you genuinely close to their quality. Where they still pull ahead — **their own dedicated global relay server networks** (vs. this app's shared free public one), years of audio-processing tuning, large-scale infrastructure — isn't realistically something to chase for a two-person app. Getting your own free TURN credentials (above) closes most of that gap; a paid TURN tier would close the rest, but is real ongoing cost for marginal gain at this scale.

## Notes & honest limitations (things to improve if you keep building this)

- **NAT traversal**: now uses both STUN and a shared public TURN relay by default, which covers the vast majority of home/mobile/corporate networks. The remaining edge cases (e.g. a network that blocks TURN relay traffic outright, or the shared public relay being temporarily overloaded) are rare but possible — getting your own free TURN credentials (see above) removes the "shared/rate-limited" variable entirely.
- **Uploaded videos** are stored on the server's disk. Free hosting tiers often wipe disk storage on redeploy/restart — fine for a movie night, not for long-term storage. For anything you want to keep, download it after.
- **Room state lives in memory**, so if the server restarts mid-session you'd need to rejoin. Good enough for two people on a call together; would need a real database for anything more persistent.
- **Reconnect handling** is basic — if you refresh your tab, you'll rejoin the room and re-sync, but the call itself needs to re-negotiate.

## Feature ideas if you want to keep adding to this

- A "director's chair" toggle — lock control of play/pause/seek to just one person for movies that need less back-and-forth fiddling.
- Saved moments could capture an actual thumbnail (canvas snapshot of the video at that timestamp) instead of just a time + note.
- A shared watchlist so you can queue up what's next without leaving the call.
- Push notification / SMS link when one of you creates a room, so the other doesn't have to be already waiting.
