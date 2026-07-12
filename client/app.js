/* ============ CONFIG ============ */
// If you host the frontend separately from the backend (e.g. client on Netlify,
// server on Render/Railway), set this to your backend's full URL, e.g.
// const SERVER_URL = "https://together-server.onrender.com";
const SERVER_URL = window.TOGETHER_SERVER_URL || "";

// When the Android app loads this page inside its WebView, it appends
// ?native=1 to the URL. In that mode, the native app owns the camera/mic/
// screen-share call entirely (using the real WebRTC Android SDK, so screen
// share can keep running in the background) — this page just handles chat,
// YouTube, Spotify, reactions, and moments, and gets out of the call's way.
const NATIVE_MODE = new URLSearchParams(window.location.search).get("native") === "1";

/* ============ STATE ============ */
let socket = null;
let roomId = null;
let myName = "You";
let localStream = null;
let pc = null;
let remoteSocketId = null;
let sourceType = "youtube"; // which TAB is currently visible — purely a UI concern now
let loadedMediaType = null; // 'youtube' | 'upload' | 'spotify' | null — whatever's actually loaded & being kept in sync, independent of which tab you're looking at
let screenShareActive = false; // true while either side has a live screen-share stream
let ytPlayer = null;
let ytReady = false;
let suppressSync = false;
let togetherSeconds = 0;
let togetherInterval = null;
let currentDuration = 0;
let amHost = false; // first person into an empty room — used to assign game roles (X/red/draws-first)

/* ---- Director's chair ---- */
let directorId = null; // socket id of whoever currently holds exclusive play/pause/seek control, or null if open to both
let directorName = null;
let lastKnownVideoState = null; // freshest official video state, used to revert a blocked local action
let loadedSourceId = null; // videoId / "type:id" / upload URL of whatever's actually loaded — used by "queue what's loaded"

// STUN alone fails on strict networks (corporate/college wifi, some carrier
// NATs, or just two people on different home networks) — TURN is a relay
// fallback for exactly those cases, and it's usually *why* two people can
// each be on a call with camera/mic working locally but never connect to
// each other. The public credentials below (Open Relay Project) are free,
// shared, and rate-limited — fine for two people, but for heavier/production
// use get your own free ones in ~2 minutes at
// https://www.metered.ca/tools/openrelay/ (or dashboard.metered.ca) and set
// window.TOGETHER_TURN_USERNAME / window.TOGETHER_TURN_CREDENTIAL before
// this script runs to override the shared ones.
const TURN_USERNAME = window.TOGETHER_TURN_USERNAME || "openrelayproject";
const TURN_CREDENTIAL = window.TOGETHER_TURN_CREDENTIAL || "openrelayproject";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: "turn:openrelay.metered.ca:443", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
];

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);

/* ============ RING LIGHT ============ */
function applyRingColor(value) {
  const isRainbow = value === "rainbow";
  document.querySelectorAll(".glow-ring").forEach((el) => el.classList.toggle("rainbow", isRainbow));
  if (!isRainbow) {
    document.documentElement.style.setProperty("--ring-color", value);
  }
  document.querySelectorAll(".ring-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.ring === value);
  });
  localStorage.setItem("together_ring_color", value);
}

document.querySelectorAll(".ring-swatch").forEach((btn) => {
  btn.addEventListener("click", () => applyRingColor(btn.dataset.ring));
});
$("ringCustomColor").addEventListener("input", (e) => applyRingColor(e.target.value));

applyRingColor(localStorage.getItem("together_ring_color") || "#F2A65A");

/* ============ LANDING ============ */

// Cursor-tracking spotlight + gentle tilt on the ticket cards — the spotlight
// position feeds the --mx/--my CSS vars from style.css, the tilt is a small
// rotation based on how far the cursor is from center.
document.querySelectorAll(".ticket, .chat-panel").forEach((card) => {
  card.addEventListener("pointermove", (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    card.style.setProperty("--mx", `${x}px`);
    card.style.setProperty("--my", `${y}px`);

    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const tiltX = ((y - cy) / cy) * -6; // degrees
    const tiltY = ((x - cx) / cx) * 6;
    card.style.transform = `perspective(600px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateY(-2px)`;
  });
  card.addEventListener("pointerleave", () => {
    card.style.transform = "";
  });
});
function randomRoomCode() {
  const words = ["glow", "reel", "dusk", "cozy", "spark", "nova", "warm", "lume"];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(100 + Math.random() * 900);
  return `${w}-${n}`;
}

// Accepts either a bare code ("glow-482") or a full invite link
// ("https://yourapp.com/?room=glow-482") pasted into the same field,
// and always normalizes to the same lowercase/trimmed format so two
// people never accidentally land in different rooms over a typo.
function normalizeRoomCode(raw) {
  if (!raw) return "";
  let value = raw.trim();
  try {
    if (value.includes("://")) {
      const url = new URL(value);
      value = url.searchParams.get("room") || value;
    }
  } catch (e) {
    // not a valid URL, treat as a plain code
  }
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

$("createRoomBtn").addEventListener("click", () => {
  const name = $("nameInputCreate").value.trim() || "Someone";
  enterRoom(randomRoomCode(), name);
});

$("joinRoomBtn").addEventListener("click", () => {
  const name = $("nameInputJoin").value.trim() || "Someone";
  const code = normalizeRoomCode($("roomCodeInput").value);
  if (!code) {
    $("landingHint").textContent = "Enter the room code they sent you (or paste their invite link).";
    return;
  }
  enterRoom(code, name);
});

// If they arrived via an invite link (?room=xyz-123), pre-fill the join code.
(function autoFillFromInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room");
  const nameParam = params.get("name");

  // The native Android app already knows the room + name — skip the landing
  // screen entirely and join straight away.
  if (NATIVE_MODE && roomParam && nameParam) {
    enterRoom(normalizeRoomCode(roomParam), decodeURIComponent(nameParam));
    return;
  }

  if (roomParam) {
    $("roomCodeInput").value = roomParam;
    $("landingHint").textContent = "Invite link detected — just add your name and hit Join room.";
  }
})();

/* ============ ENTER ROOM ============ */
async function enterRoom(id, name) {
  roomId = id;
  myName = name;

  $("landing").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("copyCodeBtn").textContent = roomId;

  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(roomId)}`;
  window.history.replaceState({}, "", url.toString());

  if (NATIVE_MODE) {
    // The native Android app handles camera, mic, call UI, and screen share.
    // Hide just the call-specific bits here so nothing overlaps/duplicates it,
    // but keep chat visible since it's no longer reachable via a toggle button.
    document.querySelector(".call-bubbles").classList.add("hidden");
    document.querySelector(".call-controls").classList.add("hidden");
    $("chatPanel").classList.remove("hidden");
    document.querySelector('.tab[data-source="screenshare"]').classList.add("hidden");
  } else {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
      },
    });
    $("localVideo").srcObject = localStream;
  } catch (err) {
    alert("Camera/mic access is needed for the call to work. You can still watch together without it.");
  }
  }

  socket = io(SERVER_URL || undefined);
  wireSocketEvents();
  socket.emit("join-room", { roomId, name: myName, role: NATIVE_MODE ? "media" : "call" });
}

$("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(roomId).then(() => {
    const original = $("copyCodeBtn").textContent;
    $("copyCodeBtn").textContent = "Copied!";
    setTimeout(() => ($("copyCodeBtn").textContent = original), 1200);
  });
});

function inviteLink() {
  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(roomId)}`;
  return url.toString();
}

$("copyLinkBtn").addEventListener("click", async () => {
  const link = inviteLink();
  const shareData = {
    title: "Join me on Together",
    text: "Come watch/call with me on Together — join here:",
    url: link,
  };

  // The native share sheet is genuinely useful on phones (Instagram, WhatsApp,
  // etc are usually installed there and show up automatically). On desktop,
  // Windows/Edge also technically supports navigator.share(), but its list
  // is whatever's registered as a Windows share target — things like Teams,
  // Outlook, Discord — NOT Instagram, since Instagram isn't a desktop app.
  // So desktop always gets our own popup instead, which has Instagram in it.
  const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isPhone && navigator.share && navigator.canShare && navigator.canShare(shareData)) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      // user cancelled the native sheet — no error needed
    }
    return;
  }

  $("sharePopup").classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!$("sharePopup").contains(e.target) && e.target !== $("copyLinkBtn")) {
    $("sharePopup").classList.add("hidden");
  }
});

function flashCopied(msg) {
  const original = $("copyLinkBtn").textContent;
  $("copyLinkBtn").textContent = msg || "✅ Link copied!";
  setTimeout(() => ($("copyLinkBtn").textContent = original), 1500);
}

$("shareWhatsapp").addEventListener("click", () => {
  window.open(`https://wa.me/?text=${encodeURIComponent("Join me on Together: " + inviteLink())}`, "_blank");
  $("sharePopup").classList.add("hidden");
});
$("shareTwitter").addEventListener("click", () => {
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent("Join me on Together")}&url=${encodeURIComponent(inviteLink())}`, "_blank");
  $("sharePopup").classList.add("hidden");
});
$("shareInstagram").addEventListener("click", () => {
  // Instagram has no web share-intent URL for pre-filled text (unlike
  // WhatsApp/X) — copying the link and opening Instagram is the honest
  // best option here, rather than a broken deep link.
  navigator.clipboard.writeText(inviteLink());
  window.open("https://instagram.com", "_blank");
  $("sharePopup").classList.add("hidden");
  flashCopied("✅ Link copied — paste it in a DM!");
});
$("shareEmail").addEventListener("click", () => {
  window.location.href = `mailto:?subject=${encodeURIComponent("Join me on Together")}&body=${encodeURIComponent("Join me on Together: " + inviteLink())}`;
  $("sharePopup").classList.add("hidden");
});
$("shareCopyPlain").addEventListener("click", () => {
  navigator.clipboard.writeText(inviteLink());
  $("sharePopup").classList.add("hidden");
  flashCopied();
});

$("leaveBtn").addEventListener("click", () => window.location.reload());

/* ============ JUST TALK MODE ============ */
// For when neither of you wants to watch/play anything and just wants to
// talk — clears the movie/game tabs out of the way so the call and chat
// are the whole screen instead of feeling like leftover unused sections.
function setJustTalkMode(on) {
  document.querySelector(".room-grid").classList.toggle("focus-mode", on);
  $("justTalkBtn").classList.toggle("active", on);
  $("justTalkBtn").textContent = on ? "🎬 Show movies & games" : "🗨️ Just talk";
  localStorage.setItem("together_just_talk", on ? "1" : "0");
}
$("justTalkBtn").addEventListener("click", () => {
  const isOn = document.querySelector(".room-grid").classList.contains("focus-mode");
  setJustTalkMode(!isOn);
});
if (localStorage.getItem("together_just_talk") === "1") setJustTalkMode(true);

/* ============ DIRECTOR'S CHAIR ============ */
// Every video-action we send goes through here so lastKnownVideoState always
// reflects the freshest state we know about — needed to revert a blocked
// local play/pause/seek back to what it should be.
function emitVideoAction(action) {
  lastKnownVideoState = { ...lastKnownVideoState, ...action };
  socket.emit("video-action", action);
}

function isPlaybackLocked() {
  return !!(directorId && socket && directorId !== socket.id);
}

// Playback controls (native YT/video-element/Spotify events, the scrubber)
// have already happened locally by the time their event fires — so a
// blocked attempt gets silently reverted back to the last official state
// instead of broadcast, and the person gets a toast explaining why.
function revertPlaybackIfLocked() {
  if (!isPlaybackLocked()) return false;
  if (lastKnownVideoState) applyRemoteVideoState(lastKnownVideoState, false);
  showDirectorToast(`${directorName || "They"} has the director's chair — only they control play/pause/seek right now.`);
  return true;
}

let directorToastTimeout = null;
function showDirectorToast(msg) {
  let el = document.getElementById("directorToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "directorToast";
    el.className = "director-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(directorToastTimeout);
  directorToastTimeout = setTimeout(() => el.classList.remove("show"), 2200);
}

function applyDirectorState(director) {
  directorId = director ? director.id : null;
  directorName = director ? director.name : null;
  const amDirector = !!(directorId && socket && directorId === socket.id);
  const btn = $("directorBtn");
  btn.classList.toggle("mine", amDirector);
  btn.classList.toggle("theirs", !!directorId && !amDirector);
  if (amDirector) {
    btn.textContent = "🎬 You're directing — tap to release";
    btn.title = "Only you control play/pause/seek right now. Tap to open it back up to both of you.";
  } else if (directorId) {
    btn.textContent = `🎬 ${directorName} is directing`;
    btn.title = `${directorName} has the director's chair right now.`;
  } else {
    btn.textContent = "🎬 Director's chair";
    btn.title = "Lock play/pause/seek to just one of you";
  }
  $("scrubberInput").disabled = !!directorId && !amDirector;
  $("filmstrip").classList.toggle("locked-out", !!directorId && !amDirector);
}

$("directorBtn").addEventListener("click", () => {
  const amDirector = !!(directorId && socket && directorId === socket.id);
  if (directorId && !amDirector) {
    showDirectorToast(`${directorName} already has the director's chair.`);
    return;
  }
  socket.emit("director-set", { take: !amDirector });
});

/* ============ WATCHLIST ============ */
function renderWatchlist(list) {
  const el = $("watchlistItems");
  el.innerHTML = "";
  if (!list || list.length === 0) {
    el.innerHTML = '<p class="watchlist-empty">Nothing queued yet — paste a link above, or queue what\'s currently loaded.</p>';
    return;
  }
  list.forEach((item) => {
    const row = document.createElement("div");
    row.className = "watchlist-item";
    const icon = item.type === "spotify" ? "🎵" : item.type === "upload" ? "📁" : "▶️";
    row.innerHTML = `<span class="wl-icon">${icon}</span><span class="wl-title">${escapeHtml(item.title)}</span><span class="wl-by">${escapeHtml(item.addedBy)}</span><button class="wl-play" title="Play for both">▶</button><button class="wl-remove" title="Remove">✕</button>`;
    row.querySelector(".wl-play").addEventListener("click", () => playWatchlistItem(item));
    row.querySelector(".wl-remove").addEventListener("click", () => socket.emit("watchlist-remove", { id: item.id }));
    el.appendChild(row);
  });
}

function playWatchlistItem(item) {
  switchToTab(item.type === "spotify" ? "spotify" : item.type === "upload" ? "upload" : "youtube");
  if (item.type === "youtube") {
    ensureYoutubePlayer(item.source, () => emitVideoAction({ type: "youtube", source: item.source, isPlaying: false, currentTime: 0 }));
  } else if (item.type === "spotify") {
    const [spType, spId] = item.source.split(":");
    ensureSpotifyPlayer({ type: spType, id: spId }, () => emitVideoAction({ type: "spotify", source: item.source, isPlaying: false, currentTime: 0 }));
  } else if (item.type === "upload") {
    loadUploadedVideo(item.source);
    emitVideoAction({ type: "upload", source: item.source, isPlaying: false, currentTime: 0 });
  }
}

function addLinkToWatchlist() {
  const raw = $("watchlistUrlInput").value.trim();
  if (!raw) return;
  const ytId = extractYoutubeId(raw);
  const ytPlaylistId = !ytId ? extractYoutubePlaylistId(raw) : null;
  const spUri = extractSpotifyUri(raw);
  if (ytId) {
    socket.emit("watchlist-add", { type: "youtube", source: ytId, title: raw });
  } else if (ytPlaylistId) {
    socket.emit("watchlist-add", { type: "youtube", source: { playlistId: ytPlaylistId }, title: raw });
  } else if (spUri) {
    socket.emit("watchlist-add", { type: "spotify", source: `${spUri.type}:${spUri.id}`, title: raw });
  } else {
    alert("That doesn't look like a YouTube or Spotify link.");
    return;
  }
  $("watchlistUrlInput").value = "";
}
$("watchlistAddBtn").addEventListener("click", addLinkToWatchlist);
$("watchlistUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addLinkToWatchlist(); });

$("queueCurrentBtn").addEventListener("click", () => {
  if (!loadedMediaType || !loadedSourceId) {
    alert("Nothing's loaded yet to queue.");
    return;
  }
  const defaultTitle = loadedMediaType === "youtube" ? "YouTube video" : loadedMediaType === "spotify" ? "Spotify track" : "Uploaded clip";
  const title = prompt("Title for this queue item? (optional)", defaultTitle) || defaultTitle;
  socket.emit("watchlist-add", { type: loadedMediaType, source: loadedSourceId, title });
});

/* ============ SOCKET EVENTS ============ */
function wireSocketEvents() {
  socket.on("room-state", ({ video, chat, theme, peers, game, director, watchlist }) => {
    applyTheme(theme);
    chat.forEach(renderChatMessage);
    if (video && video.type) applyRemoteVideoState(video, true);
    applyDirectorState(director || null);
    renderWatchlist(watchlist || []);
    amHost = peers.length === 0; // nobody was here yet -> I'm first -> I "host" any game we start
    if (game && game.id) applyRemoteGameState(game, true);
    if (!NATIVE_MODE && peers.length > 0) {
      remoteSocketId = peers[0].id;
      $("remoteName").textContent = peers[0].name;
      startPeerConnection(true, remoteSocketId);
      startTogetherTimer();
    }
  });

  if (!NATIVE_MODE) {
    socket.on("peer-joined", ({ id, name }) => {
      remoteSocketId = id;
      $("remoteName").textContent = name;
      startPeerConnection(false, id); // we are the existing peer -> we initiate the offer
      startTogetherTimer();
    });

    socket.on("peer-left", () => {
      remoteSocketId = null;
      $("remoteName").textContent = "Waiting for them…";
      $("glowRingRemote").classList.remove("connected");
      $("glowRingLocal").classList.remove("connected");
      $("remoteVideo").srcObject = null;
      $("remoteUnmuteBtn").classList.add("hidden");
      if (pc) {
        pc.close();
        pc = null;
      }
      stopTogetherTimer();
    });

    socket.on("signal", async ({ from, data }) => {
      if (!pc) startPeerConnection(false, from);
      if (data.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { to: from, data: pc.localDescription });
      } else if (data.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {}
      }
    });

    socket.on("media-status", ({ muted, screenshareBackgrounded }) => {
      if (typeof muted !== "undefined") {
        $("remoteMicBadge").classList.toggle("hidden", !muted);
      }
      if (typeof screenshareBackgrounded !== "undefined") {
        $("screenShareLabel").classList.remove("hidden");
        $("screenShareLabel").textContent = screenshareBackgrounded
          ? `${$("remoteName").textContent} switched apps — sharing is paused until they come back to this tab`
          : `${$("remoteName").textContent}'s screen`;
        $("screenShareVideo").classList.toggle("frozen", !!screenshareBackgrounded);
      }
    });
  }

  socket.on("video-action", (state) => applyRemoteVideoState(state, false));
  socket.on("sync-ping", applySyncPing);
  socket.on("director-update", applyDirectorState);
  socket.on("watchlist-update", renderWatchlist);
  socket.on("chat-message", renderChatMessage);
  socket.on("reaction", ({ emoji }) => spawnFloatingEmoji(emoji));
  socket.on("moment", renderMoment);
  socket.on("theme-change", ({ theme }) => applyTheme(theme));

  socket.on("game-select", (game) => {
    applyRemoteGameState(game, false);
    switchToTab("games"); // a freshly-started game is worth jumping to, like an incoming screen share
  });
  socket.on("game-action", (state) => applyRemoteGameState({ id: currentGame, state }, false));
  socket.on("draw-stroke", (stroke) => drawStrokeOnCanvas(stroke, false));
  socket.on("draw-clear", () => clearCanvasLocal(false));
}

/* ============ MOBILE AUTOPLAY FALLBACK ============ */
// Mobile browsers (Chrome/Android, Safari/iOS) commonly block autoplay of
// *unmuted* video without a prior tap on the page — even though the
// `autoplay` attribute is set. Muted video is always allowed to autoplay,
// which is why your own camera preview (already muted) shows up fine while
// the incoming call/screen-share video silently doesn't. This plays muted
// first (always succeeds), then tries to unmute; if the browser still
// blocks sound, it shows a one-tap button, and tapping it counts as a real
// user gesture so playback-with-sound can proceed.
function playWithUnmuteFallback(videoEl, unmuteBtn) {
  videoEl.play().catch(() => {
    videoEl.muted = true;
    videoEl.play().catch(() => {});
    unmuteBtn.classList.remove("hidden");
  });
}

function wireUnmuteButton(btnId, videoId) {
  $(btnId).addEventListener("click", () => {
    const videoEl = $(videoId);
    videoEl.muted = false;
    videoEl.play().catch(() => {});
    $(btnId).classList.add("hidden");
  });
}
wireUnmuteButton("remoteUnmuteBtn", "remoteVideo");
wireUnmuteButton("screenShareUnmuteBtn", "screenShareVideo");
wireUnmuteButton("mediaUnmuteBtn", "localVideoPlayer");
$("ytUnmuteBtn").addEventListener("click", () => {
  if (ytPlayer && ytPlayer.unMute) ytPlayer.unMute();
  $("ytUnmuteBtn").classList.add("hidden");
});
function startPeerConnection(isAnswerer, targetId) {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === "video") boostVideoBitrate(sender);
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { to: targetId, data: { candidate: e.candidate } });
  };

  // Distinguish "the camera+mic call stream" from "a screen-share stream" by
  // MediaStream identity, not by which track (audio/video) happens to fire
  // ontrack first — audio and video tracks from the same call don't have a
  // guaranteed arrival order, and the old kind==="video" check misfired
  // whenever audio arrived first, misrouting the whole call stream into the
  // screen-share slot (which is why voice could work with no picture).
  let remoteCallStreamId = null;
  pc.ontrack = (e) => {
    const incomingStream = e.streams[0];
    if (!incomingStream) return;

    // Whichever track (audio or video) shows up first from the call defines
    // the call stream's identity for every track that follows.
    if (!remoteCallStreamId) remoteCallStreamId = incomingStream.id;

    if (incomingStream.id === remoteCallStreamId) {
      $("remoteVideo").srcObject = incomingStream;
      $("glowRingRemote").classList.add("connected");
      $("glowRingLocal").classList.add("connected");
      playWithUnmuteFallback($("remoteVideo"), $("remoteUnmuteBtn"));
    } else {
      // Any stream that isn't the original call stream is a screen share.
      screenShareActive = true;
      refreshMediaVisibility();
      $("screenShareVideo").srcObject = incomingStream;
      $("screenShareVideo").muted = false;
      $("screenShareLabel").textContent = `${$("remoteName").textContent}'s screen`;
      switchToTab("screenshare");
      playWithUnmuteFallback($("screenShareVideo"), $("screenShareUnmuteBtn"));

      const vTrack = incomingStream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.onended = () => {
          screenShareActive = false;
          $("screenShareVideo").srcObject = null;
          refreshMediaVisibility();
        };
      }
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      reconnectAttempts = 0;
      setConnectionIndicator("good");
      $("connectionBanner").classList.add("hidden");
    }
    if (pc.connectionState === "disconnected") {
      $("glowRingRemote").classList.remove("connected");
      $("glowRingLocal").classList.remove("connected");
      setConnectionIndicator("poor");
      // Brief drops often self-heal (a few seconds of bad wifi); only force
      // a reconnect if it's still down a moment later.
      setTimeout(() => {
        if (pc && pc.connectionState === "disconnected") attemptReconnect(targetId);
      }, 3000);
    }
    if (pc.connectionState === "failed") {
      $("glowRingRemote").classList.remove("connected");
      $("glowRingLocal").classList.remove("connected");
      setConnectionIndicator("poor");
      attemptReconnect(targetId);
    }
  };

  if (!isAnswerer) {
    // We were already in the room; the newcomer needs an offer from us.
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit("signal", { to: targetId, data: offer });
    });
  }
}

/* ============ CALL QUALITY ============ */
let reconnectAttempts = 0;

// Browsers default to fairly conservative video bitrates that can make a
// 720p call look worse than it needs to on a decent connection — this raises
// the ceiling so quality isn't left on the table when bandwidth allows it.
async function boostVideoBitrate(sender, maxBitrate = 2_500_000) {
  try {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    await sender.setParameters(params);
  } catch (e) {
    // Some browsers don't support setParameters before the first negotiation — harmless if so.
  }
}

function attemptReconnect(targetId) {
  if (!pc) return;
  if (reconnectAttempts >= 5) {
    // Automatic retries gave up — this usually means the shared free TURN
    // relay is congested/unreachable right now, or one side's network is
    // blocking relay traffic outright. Give a manual way to try again
    // instead of silently staying broken forever.
    $("connectionBannerText").textContent =
      "Still can't connect their video/audio — this can happen on some networks. Try Retry, or have both of you reload the page.";
    $("connectionBanner").classList.remove("hidden");
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15000); // exponential backoff, capped at 15s
  setTimeout(async () => {
    if (!pc || pc.connectionState === "connected") return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: targetId, data: pc.localDescription });
    } catch (e) {}
  }, delay);
}

$("connectionRetryBtn").addEventListener("click", () => {
  $("connectionBanner").classList.add("hidden");
  reconnectAttempts = 0;
  if (remoteSocketId) attemptReconnect(remoteSocketId);
});

function setConnectionIndicator(level) {
  const dot = $("callConnectionDot");
  if (!dot) return;
  dot.classList.remove("quality-good", "quality-poor", "quality-connecting");
  dot.classList.add(`quality-${level}`);
  dot.title =
    level === "good" ? "Connection is solid" : level === "poor" ? "Connection is unstable — reconnecting…" : "Connecting…";
}

// Lightweight polling of real transport stats (packet loss + round-trip time)
// so "the call feels laggy" has an actual number behind it instead of a guess.
setInterval(async () => {
  if (!pc || pc.connectionState !== "connected") return;
  try {
    const stats = await pc.getStats();
    let packetsLost = 0;
    let packetsReceived = 0;
    let rtt = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        packetsLost += report.packetsLost || 0;
        packetsReceived += report.packetsReceived || 0;
      }
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime) {
        rtt = report.currentRoundTripTime;
      }
    });
    const lossRatio = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
    if (lossRatio > 0.05 || rtt > 0.4) setConnectionIndicator("poor");
    else setConnectionIndicator("good");
  } catch (e) {}
}, 5000);

/* ============ TOGETHER TIMER ============ */
function startTogetherTimer() {
  if (togetherInterval) return;
  togetherInterval = setInterval(() => {
    togetherSeconds++;
    const m = String(Math.floor(togetherSeconds / 60)).padStart(2, "0");
    const s = String(togetherSeconds % 60).padStart(2, "0");
    $("togetherTimer").textContent = `${m}:${s}`;
  }, 1000);
}
function stopTogetherTimer() {
  clearInterval(togetherInterval);
  togetherInterval = null;
}

/* ============ CALL CONTROLS ============ */
$("micBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("micBtn").classList.toggle("off", !track.enabled);
  $("localMicBadge").classList.toggle("hidden", track.enabled);
  socket && socket.emit("media-status", { muted: !track.enabled });
});
$("camBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("camBtn").classList.toggle("off", !track.enabled);
});
$("chatToggleBtn").addEventListener("click", () => $("chatPanel").classList.toggle("hidden"));

// On mobile, the on-screen keyboard opening resizes the visible viewport,
// and the browser's own default "scroll the focused input into view" can
// fire mid-animation (before the keyboard has finished sliding up),
// landing in the wrong spot and making the Send button appear to jump.
// Waiting until the keyboard's resize has actually settled (via
// visualViewport's resize event, with a fallback delay for browsers that
// don't support it) and then doing our own smooth, centered scroll gives
// one deliberate settle instead of a jarring one.
function settleChatInputIntoView() {
  const scrollIntoView = () => $("chatForm").scrollIntoView({ behavior: "smooth", block: "center" });
  if (window.visualViewport) {
    const onResize = () => {
      scrollIntoView();
      window.visualViewport.removeEventListener("resize", onResize);
    };
    window.visualViewport.addEventListener("resize", onResize);
    // Safety net in case the keyboard was already open (no resize fires).
    setTimeout(() => window.visualViewport.removeEventListener("resize", onResize), 600);
  }
  setTimeout(scrollIntoView, 300);
}
$("chatInput").addEventListener("focus", settleChatInputIntoView);

/* ============ CHAT ============ */
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  maybeCheckDrawGuess(text);
  $("chatInput").value = "";
});

function renderChatMessage(msg) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="who">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ============ REACTIONS ============ */
document.querySelectorAll(".reaction-btn[data-emoji]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    socket.emit("reaction", { emoji });
    spawnFloatingEmoji(emoji);
  });
});

$("moreReactionsBtn").addEventListener("click", () => {
  $("reactionBarExtra").classList.toggle("hidden");
});

function spawnFloatingEmoji(emoji) {
  const el = document.createElement("div");
  el.className = "floating-emoji";
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 80}%`;
  el.style.bottom = `${10 + Math.random() * 10}%`;
  $("reactionLayer").appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

/* ============ MOMENTS ============ */
$("momentBtn").addEventListener("click", () => {
  const note = prompt("What's happening right now? (optional note)") || "";
  const videoTime = getCurrentPlaybackTime();
  socket.emit("moment", { note, videoTime });
});

function renderMoment({ note, videoTime, name, at }) {
  const div = document.createElement("div");
  div.className = "moment";
  const timeLabel = formatTime(videoTime || 0);
  div.innerHTML = `<span class="m-name">${escapeHtml(name)}</span> saved <b>${timeLabel}</b>${note ? " — " + escapeHtml(note) : ""}`;
  $("momentsList").prepend(div);
}

function formatTime(sec) {
  sec = Math.floor(sec || 0);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ============ THEME ============ */
document.querySelectorAll(".swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme;
    applyTheme(theme);
    socket.emit("theme-change", { theme });
  });
});

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === theme));
}

/* ============ SOURCE TABS ============ */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $("sharePopup").classList.add("hidden");
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    sourceType = tab.dataset.source;
    $("youtubeControls").classList.toggle("hidden", sourceType !== "youtube");
    $("uploadControls").classList.toggle("hidden", sourceType !== "upload");
    $("spotifyControls").classList.toggle("hidden", sourceType !== "spotify");
    $("screenshareControls").classList.toggle("hidden", sourceType !== "screenshare");
    $("gamesControls").classList.toggle("hidden", sourceType !== "games");
    refreshMediaVisibility();
  });
});

// The single source of truth for "what's actually on screen right now."
// Switching tabs used to only toggle the little control bars (search box,
// upload button, etc) and never touched the actual video/audio/game surface
// underneath — so the previously-loaded thing just stayed visible (and
// audible) no matter which tab you clicked. This decides, for the currently
// selected tab, whether to show that tab's content or the empty state, and
// makes sure every OTHER surface is hidden so nothing overlaps.
function refreshMediaVisibility() {
  const showYoutube = sourceType === "youtube" && loadedMediaType === "youtube";
  const showUpload = sourceType === "upload" && loadedMediaType === "upload";
  const showSpotify = sourceType === "spotify" && loadedMediaType === "spotify";
  const showScreenshare = sourceType === "screenshare" && screenShareActive;
  const showGames = sourceType === "games" && !!currentGame;

  $("youtubePlayer").classList.toggle("hidden", !showYoutube);
  $("localVideoPlayer").classList.toggle("hidden", !showUpload);
  $("spotifyPlayer").classList.toggle("hidden", !showSpotify);
  $("screenShareVideo").classList.toggle("hidden", !showScreenshare);
  $("screenShareLabel").classList.toggle("hidden", !showScreenshare);
  $("screenShareFullscreenBtn").classList.toggle("hidden", !showScreenshare);
  $("gameArea").classList.toggle("hidden", !showGames);
  $("youtubeEmbedError").classList.add("hidden"); // only shown right after a failed load attempt
  document.querySelector(".screen-frame").classList.toggle("spotify-mode", showSpotify);

  const somethingShowing = showYoutube || showUpload || showSpotify || showScreenshare || showGames;
  $("emptyState").classList.toggle("hidden", somethingShowing);
}

function switchToTab(source) {
  const tab = document.querySelector(`.tab[data-source="${source}"]`);
  if (tab) tab.click();
}

/* ============ YOUTUBE ============ */
function getYoutubeApiKey() {
  let key = localStorage.getItem("together_youtube_api_key");
  if (!key) {
    key = prompt(
      "To search YouTube from inside the app, paste a free YouTube Data API key.\n\n" +
      "Get one in ~2 minutes: console.cloud.google.com → create a project → " +
      "enable 'YouTube Data API v3' → Credentials → Create API key.\n\n" +
      "(You can skip this and just paste video links instead, using the option below.)"
    );
    if (key) localStorage.setItem("together_youtube_api_key", key.trim());
  }
  return key ? key.trim() : null;
}

$("youtubeKeyHint").innerHTML = 'Searching by keyword needs a free <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API key</a> — but pasting a link (video, playlist, or a live stream\'s watch link) never needs one, so that\'s the most reliable option.';

$("searchYoutubeBtn").addEventListener("click", () => runYoutubeSearch());
$("youtubeSearchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runYoutubeSearch(); });

async function runYoutubeSearch() {
  const query = $("youtubeSearchInput").value.trim();
  if (!query) return;

  // If they pasted a link into the search box (instead of the dedicated
  // "paste a link" field below), just load it — no API key needed for that,
  // only text search needs one. Checked in this order because a
  // "watch?v=...&list=..." link has both a video ID and a list ID — we want
  // to play that single video, not the whole playlist.
  const pastedVideoId = extractYoutubeId(query);
  const pastedPlaylistId = !pastedVideoId ? extractYoutubePlaylistId(query) : null;
  if (pastedVideoId) {
    $("youtubeSearchResults").classList.add("hidden");
    ensureYoutubePlayer(pastedVideoId, () => {
      emitVideoAction({ type: "youtube", source: pastedVideoId, isPlaying: false, currentTime: 0 });
    });
    return;
  }
  if (pastedPlaylistId) {
    $("youtubeSearchResults").classList.add("hidden");
    ensureYoutubePlayer({ playlistId: pastedPlaylistId }, () => {
      emitVideoAction({ type: "youtube", source: { playlistId: pastedPlaylistId }, isPlaying: false, currentTime: 0 });
    });
    return;
  }

  const key = getYoutubeApiKey();
  if (!key) return;

  const resultsEl = $("youtubeSearchResults");
  resultsEl.classList.remove("hidden");
  resultsEl.innerHTML = "<p class='api-key-hint'>Searching…</p>";

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(query)}&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      // The raw Google error message is usually accurate but jargon-heavy
      // (e.g. "API key not valid", "requests from referer <empty> are
      // blocked", "quota exceeded") — translate the common cases so people
      // don't have to go decode a Google Cloud error to know what to do.
      const reason = data.error.errors?.[0]?.reason || "";
      let hint = data.error.message || "check your API key";
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        hint = "Your API key's free daily search quota is used up (resets at midnight Pacific). Paste a video/playlist link directly instead — that never needs the quota.";
      } else if (reason === "keyInvalid" || /API key not valid/i.test(hint)) {
        hint = "That API key isn't valid. Double check you copied it fully, or generate a new one in Google Cloud Console.";
      } else if (/referer|ip address/i.test(hint)) {
        hint = "This API key is restricted to a specific website/app in Google Cloud Console. Either remove that restriction, or add this app's address to its allowed list.";
      } else if (/has not been used|is not enabled|disabled/i.test(hint)) {
        hint = "The YouTube Data API v3 isn't enabled for this key's project yet — enable it in Google Cloud Console, then try again.";
      }
      resultsEl.innerHTML = `<p class="api-key-hint">Search failed: ${escapeHtml(hint)}</p>`;
      return;
    }
    resultsEl.innerHTML = "";
    (data.items || []).forEach((item) => {
      const videoId = item.id.videoId;
      const title = item.snippet.title;
      const thumb = item.snippet.thumbnails?.default?.url;
      const row = document.createElement("div");
      row.className = "search-result";
      row.innerHTML = `<img src="${thumb}" alt=""><span>${escapeHtml(title)}</span>`;
      row.addEventListener("click", () => {
        ensureYoutubePlayer(videoId, () => {
          emitVideoAction({ type: "youtube", source: videoId, isPlaying: false, currentTime: 0 });
        });
        resultsEl.classList.add("hidden");
      });
      resultsEl.appendChild(row);
    });
  } catch (err) {
    resultsEl.innerHTML = "<p class='api-key-hint'>Search failed — check your connection or API key.</p>";
  }
}

function extractYoutubeId(url) {
  const m = url.match(/(?:youtu\.be\/|v=|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// A pasted "watch?v=...&list=..." link matches extractYoutubeId above just
// fine (the single video plays, playlist part is ignored). This is only for
// links that are *just* a playlist — e.g. from YouTube's "Share playlist"
// button (youtube.com/playlist?list=...) — which have no v= for the other
// regex to find at all.
function extractYoutubePlaylistId(url) {
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function onYouTubeIframeAPIReady() {
  ytReady = true;
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

// `source` is either a plain 11-char video ID string, or a
// { playlistId: "..." } object for a pasted playlist link — the iframe embed
// can load a whole playlist directly with no YouTube Data API key needed,
// which is what lets playlist links work at all (see extractYoutubePlaylistId).
function ensureYoutubePlayer(source, cb) {
  const playlistId = source && typeof source === "object" ? source.playlistId : null;
  const videoId = playlistId ? null : source;
  loadedMediaType = "youtube";
  loadedSourceId = playlistId ? { playlistId } : videoId;
  refreshMediaVisibility();
  $("ytUnmuteBtn").classList.add("hidden");

  const create = () => {
    if (ytPlayer) {
      if (playlistId) ytPlayer.loadPlaylist({ list: playlistId, listType: "playlist" });
      else ytPlayer.loadVideoById(videoId);
      if (cb) cb();
      return;
    }
    ytPlayer = new YT.Player("youtubePlayer", {
      videoId: videoId || undefined,
      playerVars: playlistId
        ? { autoplay: 0, controls: 1, rel: 0, listType: "playlist", list: playlistId }
        : { autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady: () => { if (cb) cb(); },
        onStateChange: onYoutubeStateChange,
        onError: (e) => onYoutubeError(e, videoId),
      },
    });
  };

  if (ytReady) create();
  else setTimeout(() => ensureYoutubePlayer(source, cb), 300);
}

// YouTube error codes 101 and 150 both mean "the uploader disabled playback
// on other sites" — that's a restriction on YouTube's end, not something any
// embedding app can work around. Instead of leaving a half-broken "Watch on
// YouTube" box on screen, show a clear explanation with a direct link out.
function onYoutubeError(e, videoId) {
  const code = e && e.data;
  const box = $("youtubeEmbedError");
  if (code === 101 || code === 150) {
    box.innerHTML = `This video can't be played inside the app — the uploader disabled embedding.
      <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">Open it on YouTube instead ↗</a>`;
  } else {
    box.innerHTML = `This video couldn't be loaded (YouTube error ${code ?? "unknown"}). Try a different link.`;
  }
  box.classList.remove("hidden");
  $("youtubePlayer").classList.add("hidden");
}

let lastYtState = null;
function onYoutubeStateChange(e) {
  if (suppressSync) return;
  if (e.data === YT.PlayerState.PLAYING) {
    if (revertPlaybackIfLocked()) return;
    emitVideoAction({ type: "youtube", isPlaying: true, currentTime: ytPlayer.getCurrentTime() });
  } else if (e.data === YT.PlayerState.PAUSED) {
    if (revertPlaybackIfLocked()) return;
    emitVideoAction({ type: "youtube", isPlaying: false, currentTime: ytPlayer.getCurrentTime() });
  }
}

$("loadYoutubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrlInput").value.trim();
  const videoId = extractYoutubeId(url);
  const playlistId = !videoId ? extractYoutubePlaylistId(url) : null;
  if (!videoId && !playlistId) {
    alert("That doesn't look like a valid YouTube video or playlist link.");
    return;
  }
  if (playlistId) {
    ensureYoutubePlayer({ playlistId }, () => {
      emitVideoAction({ type: "youtube", source: { playlistId }, isPlaying: false, currentTime: 0 });
    });
  } else {
    ensureYoutubePlayer(videoId, () => {
      emitVideoAction({ type: "youtube", source: videoId, isPlaying: false, currentTime: 0 });
    });
  }
});

/* ============ SPOTIFY ============ */
let spotifyController = null;
let spotifyIframeAPI = null;
let spotifyLastPosition = 0;
let spotifyLastDuration = 0;

window.onSpotifyIframeApiReady = (IFrameAPI) => {
  spotifyIframeAPI = IFrameAPI;
};

function extractSpotifyUri(url) {
  // Matches track/album/playlist/episode links like:
  // https://open.spotify.com/track/{id}?si=...
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

function ensureSpotifyPlayer(uri, cb) {
  loadedMediaType = "spotify";
  loadedSourceId = `${uri.type}:${uri.id}`;
  refreshMediaVisibility();

  const create = () => {
    const el = $("spotifyPlayer");
    el.innerHTML = "";
    const options = { uri: `spotify:${uri.type}:${uri.id}` };
    spotifyIframeAPI.createController(el, options, (controller) => {
      spotifyController = controller;
      controller.addListener("playback_update", (e) => {
        spotifyLastPosition = e.data.position / 1000;
        spotifyLastDuration = e.data.duration / 1000;
        if (suppressSync) return;
        if (revertPlaybackIfLocked()) return;
        emitVideoAction({
          type: "spotify",
          isPlaying: !e.data.isPaused,
          currentTime: e.data.position / 1000,
        });
      });
      if (cb) cb();
    });
  };

  if (spotifyIframeAPI) create();
  else setTimeout(() => ensureSpotifyPlayer(uri, cb), 300);
}

function applySpotifyPlaybackState(state) {
  if (!spotifyController) return;
  const drift = Math.abs(spotifyLastPosition - (state.currentTime || 0));
  if (drift > 1.5 && spotifyController.seek) spotifyController.seek(state.currentTime || 0);
  if (state.isPlaying) spotifyController.resume();
  else spotifyController.pause();
}

$("loadSpotifyBtn").addEventListener("click", () => {
  const url = $("spotifyUrlInput").value.trim();
  const uri = extractSpotifyUri(url);
  if (!uri) {
    alert("That doesn't look like a valid Spotify link (track, album, playlist, or episode).");
    return;
  }
  ensureSpotifyPlayer(uri, () => {
    emitVideoAction({ type: "spotify", source: `${uri.type}:${uri.id}`, isPlaying: false, currentTime: 0 });
  });
});

/* ============ SCREEN SHARE ============ */
let screenStream = null;
let screenSender = null;
let screenAudioSender = null;
let remoteScreenStreamId = null;

const SCREEN_SHARE_SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function initScreenShareSupport() {
  if (SCREEN_SHARE_SUPPORTED) return;
  const msg = /iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Screen sharing isn't supported on iPhone/iPad browsers — that's an Apple restriction, not this app. Try from a laptop instead."
    : "Screen sharing isn't supported in this browser. Try Chrome on a laptop for this feature.";
  $("screenShareBtn").disabled = true;
  $("screenShareBtn").title = msg;
  $("screenShareBtn").style.opacity = "0.4";
  $("screenShareBtn").style.cursor = "not-allowed";
  $("startScreenShareBtn").disabled = true;
  $("screenshareStatus").textContent = msg;
}

async function renegotiate() {
  if (!pc || !remoteSocketId) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: remoteSocketId, data: pc.localDescription });
}

async function startScreenShare() {
  if (!SCREEN_SHARE_SUPPORTED) {
    alert(
      /iPhone|iPad|iPod/.test(navigator.userAgent)
        ? "Screen sharing isn't supported on iPhone/iPad — Apple doesn't allow browsers to do this. Try from a laptop."
        : "Screen sharing isn't supported in this browser. Try Chrome on a laptop."
    );
    return;
  }
  // Quality picker (Kosmi-style): Auto lets the browser/OS decide; the fixed
  // options cap the capture resolution so a slower connection can still keep
  // up, at the cost of sharpness.
  const quality = $("screenShareQuality") ? $("screenShareQuality").value : "auto";
  const QUALITY_PRESETS = {
    "1080": { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30 } },
    "720": { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30 } },
    "480": { width: { ideal: 854, max: 854 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 24 } },
  };
  const videoConstraints = { cursor: "always", ...(QUALITY_PRESETS[quality] || {}) };

  try {
    // audio: true captures tab/system sound where the browser & OS allow it —
    // in Chrome's share picker, pick the "Chrome Tab" option and tick
    // "Share tab audio" for the most reliable result. Full-desktop sharing
    // on macOS can't capture system audio at all (an OS-level limit, not
    // something any app can work around).
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: true });
  } catch (err) {
    return; // user cancelled the picker
  }
  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];
  videoTrack.contentHint = "detail"; // hint encoders to favor sharpness over motion smoothness

  if (pc) {
    screenSender = pc.addTrack(videoTrack, screenStream);
    if (audioTrack) screenAudioSender = pc.addTrack(audioTrack, screenStream);
    renegotiate();
    // Apply a bitrate ceiling matched to the chosen resolution so quality
    // isn't left on the table (Auto/1080p) or wasted on a slow link (480p).
    const BITRATE_BY_QUALITY = { auto: 4_000_000, "1080": 4_000_000, "720": 2_500_000, "480": 1_200_000 };
    setTimeout(() => boostVideoBitrate(screenSender, BITRATE_BY_QUALITY[quality] || 2_500_000), 500);
  }

  screenShareActive = true;
  refreshMediaVisibility();
  $("screenShareVideo").srcObject = screenStream;
  $("screenShareVideo").muted = true;
  $("screenShareLabel").textContent = audioTrack
    ? "You're sharing your screen (with sound)"
    : "You're sharing your screen (no sound captured — see tip below)";

  $("screenShareBtn").classList.add("active");
  $("startScreenShareBtn").textContent = "Stop sharing";

  videoTrack.onended = stopScreenShare; // user clicked the browser's native "Stop sharing" button

  // On phones (mainly Android Chrome), switching to another app freezes the
  // shared tab — the other person would otherwise just see a silent, frozen
  // frame with no explanation. Tell them plainly instead of leaving it a mystery.
  document.addEventListener("visibilitychange", handleShareVisibilityChange);
}

function handleShareVisibilityChange() {
  if (!screenStream || !socket) return;
  const backgrounded = document.visibilityState === "hidden";
  socket.emit("media-status", { screenshareBackgrounded: backgrounded });
}

function stopScreenShare() {
  document.removeEventListener("visibilitychange", handleShareVisibilityChange);
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (pc) {
    if (screenSender) { try { pc.removeTrack(screenSender); } catch (e) {} screenSender = null; }
    if (screenAudioSender) { try { pc.removeTrack(screenAudioSender); } catch (e) {} screenAudioSender = null; }
    renegotiate();
  }
  socket && socket.emit("media-status", { screenshareBackgrounded: false });
  screenShareActive = false;
  $("screenShareVideo").srcObject = null;
  refreshMediaVisibility();
  $("screenShareBtn").classList.remove("active");
  $("startScreenShareBtn").textContent = "Start sharing your screen";
}

$("screenShareBtn").addEventListener("click", () => {
  switchToTab("screenshare");
  if (screenStream) stopScreenShare();
  else startScreenShare();
});
$("startScreenShareBtn").addEventListener("click", () => {
  if (screenStream) stopScreenShare();
  else startScreenShare();
});

$("screenShareFullscreenBtn").addEventListener("click", () => {
  const frame = document.querySelector(".screen-frame");
  if (document.fullscreenElement) document.exitFullscreen();
  else frame.requestFullscreen().catch(() => {});
});

/* ============ UPLOAD ============ */
const MAX_UPLOAD_MB = 150;

$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file || !roomId) return;

  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > MAX_UPLOAD_MB) {
    $("uploadStatus").textContent = `That clip is ${Math.round(sizeMB)}MB — over the ${MAX_UPLOAD_MB}MB limit. Trim it shorter or compress it first.`;
    e.target.value = "";
    return;
  }

  $("uploadStatus").textContent = "Uploading… 0%";

  const form = new FormData();
  form.append("video", file);

  // Using XMLHttpRequest instead of fetch specifically because fetch has no
  // upload-progress event — on a slow mobile connection "Uploading…" with no
  // number is indistinguishable from actually being stuck.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${SERVER_URL}/api/upload/${roomId}`);
  xhr.timeout = 10 * 60 * 1000; // matches the server's requestTimeout

  xhr.upload.addEventListener("progress", (evt) => {
    if (!evt.lengthComputable) return;
    const pct = Math.round((evt.loaded / evt.total) * 100);
    $("uploadStatus").textContent = `Uploading… ${pct}%`;
  });

  xhr.addEventListener("load", () => {
    let data;
    try {
      data = JSON.parse(xhr.responseText);
    } catch (err) {
      $("uploadStatus").textContent = "Upload failed — the server sent back something unexpected. Try again in a moment.";
      return;
    }
    if (xhr.status >= 200 && xhr.status < 300 && data.url) {
      loadUploadedVideo(data.url);
      emitVideoAction({ type: "upload", source: data.url, isPlaying: false, currentTime: 0 });
      $("uploadStatus").textContent = `Loaded: ${data.name}`;
    } else {
      $("uploadStatus").textContent = data.error || "Upload failed. Try again.";
    }
  });

  xhr.addEventListener("error", () => {
    $("uploadStatus").textContent = "Upload failed — check your connection and that the server is awake (open the site once first if it's been idle a while).";
  });

  xhr.addEventListener("timeout", () => {
    $("uploadStatus").textContent = "Upload timed out — your connection may be too slow for this file size. Try a smaller clip or a better connection.";
  });

  xhr.send(form);
});

function loadUploadedVideo(url) {
  loadedMediaType = "upload";
  loadedSourceId = url;
  refreshMediaVisibility();
  const v = $("localVideoPlayer");
  v.src = url.startsWith("http") ? url : `${SERVER_URL}${url}`;
}

const videoEl = $("localVideoPlayer");
videoEl.addEventListener("play", () => {
  if (suppressSync) return;
  if (revertPlaybackIfLocked()) return;
  emitVideoAction({ type: "upload", isPlaying: true, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("pause", () => {
  if (suppressSync) return;
  if (revertPlaybackIfLocked()) return;
  emitVideoAction({ type: "upload", isPlaying: false, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("seeked", () => {
  if (suppressSync) return;
  if (revertPlaybackIfLocked()) return;
  emitVideoAction({ type: "upload", isPlaying: !videoEl.paused, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("timeupdate", updateFilmstripFromLocal);

/* ============ APPLY REMOTE STATE ============ */
function applyRemoteVideoState(state, isInitialSync) {
  if (!state || !state.type) return;
  lastKnownVideoState = state;
  suppressSync = true;
  // Release suppressSync only after the player has actually finished
  // reacting (seeking/loading/buffering), not on a fixed timer — on a
  // slower connection, buffering can easily take longer than a fixed
  // delay, which was letting the flag clear early. When it did, the
  // player's own delayed "now playing" event looked like a brand-new local
  // action and got echoed straight back to the other device — that's what
  // caused both the restart-loop and the "pause only worked on one side"
  // symptoms (a genuine local pause could get silently swallowed if it
  // landed while a stale echo had the flag stuck on).
  const release = () => setTimeout(() => (suppressSync = false), 400);

  if (state.type === "youtube") {
    if (state.source) {
      ensureYoutubePlayer(state.source, () => { seekAndPlayYoutube(state); release(); });
    } else if (ytPlayer) {
      seekAndPlayYoutube(state);
      release();
    } else {
      suppressSync = false;
    }
  } else if (state.type === "upload") {
    if (state.source) {
      const fullUrl = state.source.startsWith("http") ? state.source : `${SERVER_URL}${state.source}`;
      if (videoEl.src !== fullUrl) loadUploadedVideo(state.source);
    }
    const drift = Math.abs(videoEl.currentTime - (state.currentTime || 0));
    const extraElapsed = isInitialSync ? (Date.now() - state.updatedAt) / 1000 : 0;
    const targetTime = (state.currentTime || 0) + Math.max(0, extraElapsed);
    if (drift > 1) videoEl.currentTime = targetTime;
    // A play() triggered here is reacting to the *other* person's tap, not
    // a gesture on this page — mobile Chrome/Safari block unmuted
    // programmatic playback in that case and just silently fail, which is
    // what showed up as "black screen, no sound" on phones (desktop is more
    // lenient, so the same code looked fine there). Same fallback already
    // used for the incoming call/screen-share video: try normally, and if
    // that's blocked, play muted (always allowed) and offer a one-tap
    // unmute button.
    if (state.isPlaying) playWithUnmuteFallback(videoEl, $("mediaUnmuteBtn"));
    else videoEl.pause();
    release();
  } else if (state.type === "spotify") {
    if (state.source && spotifyController === null) {
      const [type, id] = state.source.split(":");
      ensureSpotifyPlayer({ type, id }, () => { applySpotifyPlaybackState(state); release(); });
    } else if (spotifyController) {
      applySpotifyPlaybackState(state);
      release();
    } else {
      suppressSync = false;
    }
  } else {
    suppressSync = false;
  }
}

function seekAndPlayYoutube(state) {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const drift = Math.abs(ytPlayer.getCurrentTime() - (state.currentTime || 0));
  if (drift > 1.2) ytPlayer.seekTo(state.currentTime || 0, true);
  if (state.isPlaying) {
    ytPlayer.playVideo();
    // Same mobile autoplay block as the uploaded-video case, but the
    // YouTube iframe API has no play()-promise to catch — it just quietly
    // stays paused instead. Give it a beat, then check whether it actually
    // started; if not, fall back to muted playback (always allowed) with a
    // tap-to-unmute button.
    setTimeout(() => {
      if (ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() !== 1 /* YT.PlayerState.PLAYING */) {
        ytPlayer.mute();
        ytPlayer.playVideo();
        $("ytUnmuteBtn").classList.remove("hidden");
      }
    }, 700);
  } else {
    ytPlayer.pauseVideo();
    $("ytUnmuteBtn").classList.add("hidden");
  }
}

/* ============ FILMSTRIP SCRUBBER ============ */
function getCurrentPlaybackTime() {
  if (sourceType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  if (sourceType === "upload") return videoEl.currentTime;
  if (sourceType === "spotify") return spotifyLastPosition;
  return 0;
}
// Same idea, but follows whatever's actually loaded rather than whichever
// tab you're currently looking at — used for background sync so drift
// correction keeps working while you're browsing Games/Screenshare/etc.
function getLoadedPlaybackTime() {
  if (loadedMediaType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  if (loadedMediaType === "upload") return videoEl.currentTime;
  if (loadedMediaType === "spotify") return spotifyLastPosition;
  return 0;
}
function getDuration() {
  if (sourceType === "youtube" && ytPlayer && ytPlayer.getDuration) return ytPlayer.getDuration() || 0;
  if (sourceType === "upload") return videoEl.duration || 0;
  if (sourceType === "spotify") return spotifyLastDuration || 0;
  return 0;
}

function updateFilmstripFromLocal() {
  const dur = getDuration();
  const cur = getCurrentPlaybackTime();
  if (!dur) return;
  const pct = (cur / dur) * 100;
  $("progressFill").style.width = `${pct}%`;
  $("scrubberInput").value = Math.floor((cur / dur) * 1000);
}

setInterval(updateFilmstripFromLocal, 500);

$("scrubberInput").addEventListener("input", (e) => {
  const dur = getDuration();
  if (!dur) return;
  const target = (e.target.value / 1000) * dur;
  if (sourceType === "youtube" && ytPlayer) ytPlayer.seekTo(target, true);
  else if (sourceType === "upload") videoEl.currentTime = target;
  else if (sourceType === "spotify" && spotifyController && spotifyController.seek) spotifyController.seek(target);
});
$("scrubberInput").addEventListener("change", () => {
  if (revertPlaybackIfLocked()) return;
  const cur = getCurrentPlaybackTime();
  const isPlaying = sourceType === "upload" ? !videoEl.paused : true;
  emitVideoAction({ type: sourceType, isPlaying, currentTime: cur });
});

/* ============ DOUBLE-TAP REACTION ON SCREEN ============ */
document.querySelector(".screen-frame").addEventListener("dblclick", () => {
  socket.emit("reaction", { emoji: "❤️" });
  spawnFloatingEmoji("❤️");
});

initScreenShareSupport();
applyDirectorState(null);
renderWatchlist([]);

/* ============ PERIODIC DRIFT CORRECTION ============ */
// play/pause/seek events keep things roughly in sync, but small gaps build up
// over a few minutes (buffering, slightly different clocks, etc). Every few
// seconds each side quietly reports where it actually is, and the other side
// nudges its own position back in line if it's drifted more than ~1.5s.
setInterval(() => {
  if (!socket || !roomId) return;
  if (loadedMediaType !== "youtube" && loadedMediaType !== "spotify" && loadedMediaType !== "upload") return;
  const currentTime = getLoadedPlaybackTime();
  if (!currentTime) return;
  socket.emit("sync-ping", { type: loadedMediaType, currentTime });
}, 4000);

function applySyncPing(state) {
  if (suppressSync || state.type !== loadedMediaType) return;
  const localTime = getLoadedPlaybackTime();
  const drift = Math.abs(localTime - (state.currentTime || 0));
  if (drift < 1.5) return;

  suppressSync = true;
  if (loadedMediaType === "youtube" && ytPlayer && ytPlayer.seekTo) {
    ytPlayer.seekTo(state.currentTime, true);
  } else if (loadedMediaType === "upload") {
    videoEl.currentTime = state.currentTime;
  } else if (loadedMediaType === "spotify" && spotifyController && spotifyController.seek) {
    spotifyController.seek(state.currentTime);
  }
  // A seek can trigger a brief buffering spell before settling back to
  // playing — give it more headroom than a play/pause reaction needs, so a
  // slow connection doesn't let this clear early and misread its own
  // delayed "playing again" event as a new local action (same root cause
  // as the fix in applyRemoteVideoState above, just for the smaller
  // periodic correction instead of a full play/pause).
  setTimeout(() => (suppressSync = false), 1200);
}

/* ============ GAMES ============ */
// Same trust model as the rest of the app (no server-side validation of
// video state, chat, etc.) — the server just relays the latest state and
// both clients compute turns/winners identically. Good enough for two
// people who trust each other; not meant to survive a determined cheater.

let currentGame = null; // 'ttt' | 'connect4' | 'draw' | null
let tttState = null;
let c4State = null;
let drawState = null;
let drawCtx = null;
let isDrawingNow = false;
let lastDrawPoint = null;
let currentDrawColor = "#1a1300";
let currentDrawSize = 4;

const DRAW_WORDS = [
  "pizza", "guitar", "sunset", "castle", "dragon", "bicycle", "rainbow", "penguin",
  "volcano", "sandwich", "umbrella", "spaceship", "waterfall", "butterfly", "campfire",
  "lighthouse", "snowman", "treasure", "octopus", "skateboard", "balloon", "jellyfish",
  "cactus", "mermaid", "robot", "pancake", "tornado", "unicorn", "backpack", "fireworks",
];

document.querySelectorAll(".game-pick-btn").forEach((btn) => {
  btn.addEventListener("click", () => startGame(btn.dataset.game));
});
$("gameNewBtn").addEventListener("click", () => { if (currentGame) startGame(currentGame); });

function startGame(gameId) {
  currentGame = gameId;
  document.querySelectorAll(".game-pick-btn").forEach((b) => b.classList.toggle("active", b.dataset.game === gameId));
  $("gameNewBtn").classList.remove("hidden");

  let initialState;
  if (gameId === "ttt") {
    initialState = { board: Array(9).fill(null), turn: "X", winner: null, winLine: null };
  } else if (gameId === "connect4") {
    initialState = { board: Array(42).fill(null), turn: "red", winner: null, winLine: null };
  } else if (gameId === "draw") {
    const word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
    initialState = { drawerIsHost: true, word, round: 1, score: { host: 0, guest: 0 }, revealed: false };
  }
  socket.emit("game-select", { id: gameId, state: initialState });
  applyRemoteGameState({ id: gameId, state: initialState }, true);
}

// `mine` = true when this update originated on our own client (either we
// just picked the game, or we're replaying room-state on join) — used only
// to avoid re-emitting an echo of what we just sent. This function only
// ever updates the underlying game data/render — it never decides whether
// the Games tab is actually visible right now; refreshMediaVisibility()
// (driven by whichever tab you're actually looking at) owns that.
function applyRemoteGameState(game, mine) {
  if (!game || !game.id) return;
  currentGame = game.id;
  document.querySelectorAll(".game-pick-btn").forEach((b) => b.classList.toggle("active", b.dataset.game === game.id));
  $("gameNewBtn").classList.remove("hidden");
  refreshMediaVisibility();

  if (game.id === "ttt") {
    tttState = game.state;
    renderTTT();
  } else if (game.id === "connect4") {
    c4State = game.state;
    renderConnect4();
  } else if (game.id === "draw") {
    drawState = game.state;
    renderDrawGame(!mine); // only clear canvas on a fresh round pushed by the other player
  }
}

/* ---- Tic-Tac-Toe ---- */
const TTT_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];
function tttCheckWinner(board) {
  for (const line of TTT_LINES) {
    const [a,b,c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line };
  }
  if (board.every((c) => c)) return { winner: "draw", line: null };
  return null;
}

function renderTTT() {
  const mySymbol = amHost ? "X" : "O";
  const isMyTurn = tttState.turn === mySymbol && !tttState.winner;
  const status = tttState.winner
    ? tttState.winner === "draw" ? "It's a draw!" : `<b>${tttState.winner}</b> wins! 🎉`
    : isMyTurn ? `Your turn (<b>${mySymbol}</b>)` : `Waiting on them (<b>${tttState.turn}</b>)`;

  const cells = tttState.board.map((val, i) => {
    const isWin = tttState.winLine && tttState.winLine.includes(i);
    return `<div class="ttt-cell ${val ? "filled" : ""} ${val === "O" ? "o-mark" : ""} ${isWin ? "win-cell" : ""}" data-i="${i}">${val || ""}</div>`;
  }).join("");

  $("gameArea").innerHTML = `
    <div class="game-status-line">${status}</div>
    <div class="ttt-board">${cells}</div>
  `;

  $("gameArea").querySelectorAll(".ttt-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      const i = Number(cell.dataset.i);
      if (tttState.winner || tttState.board[i] || tttState.turn !== mySymbol) return;
      const board = tttState.board.slice();
      board[i] = mySymbol;
      const result = tttCheckWinner(board);
      tttState = {
        board,
        turn: mySymbol === "X" ? "O" : "X",
        winner: result ? result.winner : null,
        winLine: result ? result.line : null,
      };
      socket.emit("game-action", tttState);
      renderTTT();
    });
  });
}

/* ---- Connect Four ---- */
// board is a flat array of 42 cells, row-major, row 0 = top.
function c4DropRow(board, col) {
  for (let row = 5; row >= 0; row--) {
    if (!board[row * 7 + col]) return row;
  }
  return -1;
}
function c4CheckWinner(board) {
  const get = (r, c) => (r < 0 || r > 5 || c < 0 || c > 6 ? null : board[r * 7 + c]);
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const color = get(r, c);
      if (!color) continue;
      for (const [dr, dc] of dirs) {
        const cells = [0,1,2,3].map((k) => [r + dr*k, c + dc*k]);
        if (cells.every(([rr, cc]) => get(rr, cc) === color)) {
          return { winner: color, line: cells.map(([rr, cc]) => rr * 7 + cc) };
        }
      }
    }
  }
  if (board.every((c) => c)) return { winner: "draw", line: null };
  return null;
}

function renderConnect4() {
  const myColor = amHost ? "red" : "yellow";
  const isMyTurn = c4State.turn === myColor && !c4State.winner;
  const status = c4State.winner
    ? c4State.winner === "draw" ? "It's a draw!" : `<b style="color:${c4State.winner === "red" ? "var(--danger)" : "var(--accent)"}">${c4State.winner}</b> wins! 🎉`
    : isMyTurn ? `Your turn (<b>${myColor}</b>)` : `Waiting on them (<b>${c4State.turn}</b>)`;

  const cells = c4State.board.map((val, i) => {
    const isWin = c4State.winLine && c4State.winLine.includes(i);
    return `<div class="c4-cell ${val || "empty"} ${isWin ? "win-cell" : ""}" data-col="${i % 7}"></div>`;
  }).join("");

  $("gameArea").innerHTML = `
    <div class="game-status-line">${status}</div>
    <div class="c4-board">${cells}</div>
  `;

  $("gameArea").querySelectorAll(".c4-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      const col = Number(cell.dataset.col);
      if (c4State.winner || c4State.turn !== myColor) return;
      const row = c4DropRow(c4State.board, col);
      if (row === -1) return; // column full
      const board = c4State.board.slice();
      board[row * 7 + col] = myColor;
      const result = c4CheckWinner(board);
      c4State = {
        board,
        turn: myColor === "red" ? "yellow" : "red",
        winner: result ? result.winner : null,
        winLine: result ? result.line : null,
      };
      socket.emit("game-action", c4State);
      renderConnect4();
    });
  });
}

/* ---- Draw & Guess ---- */
function renderDrawGame(clearCanvas) {
  const amDrawer = (amHost && drawState.drawerIsHost) || (!amHost && !drawState.drawerIsHost);
  const wordDisplay = amDrawer
    ? `Your word: <b>${drawState.word}</b>`
    : `<span class="word-blanks">${drawState.word.split("").map(() => "_").join(" ")}</span> (${drawState.word.length} letters)`;
  const myScore = amHost ? drawState.score.host : drawState.score.guest;
  const theirScore = amHost ? drawState.score.guest : drawState.score.host;

  $("gameArea").innerHTML = `
    <div class="draw-wrap">
      <div class="game-status-line">
        Round ${drawState.round} · You ${myScore} – ${theirScore} them ·
        ${amDrawer ? "You're drawing, they're guessing! 🎨" : "Guess the word in chat 👀"}
      </div>
      <div class="game-status-line">${wordDisplay}</div>
      <div class="draw-toolbar">
        ${["#1a1300","#E2607A","#8C9EFF","#3fae56","#F2A65A","#ffffff"].map((c) =>
          `<button class="draw-color" data-color="${c}" style="background:${c}"></button>`).join("")}
        <button id="drawClearBtn" class="btn btn-ghost btn-small">🧹 Clear</button>
        ${amDrawer ? '<button id="drawSkipBtn" class="btn btn-ghost btn-small">⏭️ Skip word</button>' : ""}
      </div>
      <canvas id="drawCanvas" width="600" height="360"></canvas>
    </div>
  `;

  const canvas = $("drawCanvas");
  drawCtx = canvas.getContext("2d");
  if (clearCanvas !== false) drawCtx.clearRect(0, 0, canvas.width, canvas.height);

  $("gameArea").querySelectorAll(".draw-color").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentDrawColor = btn.dataset.color;
      $("gameArea").querySelectorAll(".draw-color").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  $("drawClearBtn").addEventListener("click", () => clearCanvasLocal(true));
  if (amDrawer) {
    $("drawSkipBtn").addEventListener("click", () => advanceDrawRound(false));
    canvas.addEventListener("pointerdown", (e) => { isDrawingNow = true; lastDrawPoint = canvasPoint(canvas, e); });
    canvas.addEventListener("pointermove", (e) => {
      if (!isDrawingNow) return;
      const pt = canvasPoint(canvas, e);
      const stroke = { x0: lastDrawPoint.x, y0: lastDrawPoint.y, x1: pt.x, y1: pt.y, color: currentDrawColor, size: currentDrawSize };
      drawStrokeOnCanvas(stroke, true);
      socket.emit("draw-stroke", stroke);
      lastDrawPoint = pt;
    });
    ["pointerup", "pointerleave"].forEach((ev) => canvas.addEventListener(ev, () => (isDrawingNow = false)));
  } else {
    canvas.style.cursor = "default";
  }
}

function canvasPoint(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function drawStrokeOnCanvas(stroke) {
  if (!drawCtx) return;
  drawCtx.strokeStyle = stroke.color;
  drawCtx.lineWidth = stroke.size;
  drawCtx.lineCap = "round";
  drawCtx.beginPath();
  drawCtx.moveTo(stroke.x0, stroke.y0);
  drawCtx.lineTo(stroke.x1, stroke.y1);
  drawCtx.stroke();
}

function clearCanvasLocal(broadcast) {
  const canvas = $("drawCanvas");
  if (canvas && drawCtx) drawCtx.clearRect(0, 0, canvas.width, canvas.height);
  if (broadcast) socket.emit("draw-clear");
}

// Called when a chat message is submitted while the Draw & Guess game is
// active — checks it against the current word and, if right, scores a
// point, swaps who's drawing, and starts a new round.
function maybeCheckDrawGuess(text) {
  if (currentGame !== "draw" || !drawState) return;
  const amDrawer = (amHost && drawState.drawerIsHost) || (!amHost && !drawState.drawerIsHost);
  if (amDrawer) return; // the drawer guessing their own word doesn't count
  if (text.trim().toLowerCase() === drawState.word.toLowerCase()) {
    advanceDrawRound(true);
  }
}

function advanceDrawRound(guesserWon) {
  const score = { ...drawState.score };
  if (guesserWon) {
    if (amHost && !drawState.drawerIsHost) score.host += 1; // host was guessing and won
    if (!amHost && drawState.drawerIsHost) score.guest += 1; // guest was guessing and won
  }
  const word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  drawState = {
    drawerIsHost: !drawState.drawerIsHost, // swap who draws next
    word,
    round: drawState.round + 1,
    score,
    revealed: false,
  };
  socket.emit("game-action", drawState);
  renderDrawGame(true);
  if (guesserWon) {
    socket.emit("reaction", { emoji: "🎉" });
    spawnFloatingEmoji("🎉");
  }
}
