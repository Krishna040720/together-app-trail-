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
let sourceType = "youtube"; // 'youtube' | 'upload'
let ytPlayer = null;
let ytReady = false;
let suppressSync = false;
let togetherSeconds = 0;
let togetherInterval = null;
let currentDuration = 0;

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);

/* ============ LANDING ============ */
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
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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

$("copyLinkBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(inviteLink()).then(() => {
    const original = $("copyLinkBtn").textContent;
    $("copyLinkBtn").textContent = "✅ Link copied!";
    setTimeout(() => ($("copyLinkBtn").textContent = original), 1500);
  });
});

$("leaveBtn").addEventListener("click", () => window.location.reload());

/* ============ SOCKET EVENTS ============ */
function wireSocketEvents() {
  socket.on("room-state", ({ video, chat, theme, peers }) => {
    applyTheme(theme);
    chat.forEach(renderChatMessage);
    if (video && video.type) applyRemoteVideoState(video, true);
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
  socket.on("chat-message", renderChatMessage);
  socket.on("reaction", ({ emoji }) => spawnFloatingEmoji(emoji));
  socket.on("moment", renderMoment);
  socket.on("theme-change", ({ theme }) => applyTheme(theme));
}

/* ============ WEBRTC ============ */
function startPeerConnection(isAnswerer, targetId) {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { to: targetId, data: { candidate: e.candidate } });
  };

  let remoteCameraStreamId = null;
  pc.ontrack = (e) => {
    const incomingStream = e.streams[0];
    const isFirstVideoStream = !remoteCameraStreamId && e.track.kind === "video";

    if (isFirstVideoStream || incomingStream.id === remoteCameraStreamId) {
      if (isFirstVideoStream) remoteCameraStreamId = incomingStream.id;
      $("remoteVideo").srcObject = incomingStream;
      $("glowRingRemote").classList.add("connected");
      $("glowRingLocal").classList.add("connected");
    } else {
      // A second, different video stream = they've started sharing their screen.
      $("emptyState").classList.add("hidden");
      $("screenShareVideo").classList.remove("hidden");
      $("screenShareVideo").srcObject = incomingStream;
      $("screenShareVideo").muted = false;
      $("screenShareLabel").textContent = `${$("remoteName").textContent}'s screen`;
      $("screenShareLabel").classList.remove("hidden");
      switchToTab("screenshare");

      incomingStream.getVideoTracks()[0].onended = () => {
        $("screenShareVideo").classList.add("hidden");
        $("screenShareLabel").classList.add("hidden");
      };
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
      $("glowRingRemote").classList.remove("connected");
      $("glowRingLocal").classList.remove("connected");
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

/* ============ CHAT ============ */
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
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
document.querySelectorAll(".reaction-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    socket.emit("reaction", { emoji });
    spawnFloatingEmoji(emoji);
  });
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
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    sourceType = tab.dataset.source;
    $("youtubeControls").classList.toggle("hidden", sourceType !== "youtube");
    $("uploadControls").classList.toggle("hidden", sourceType !== "upload");
    $("spotifyControls").classList.toggle("hidden", sourceType !== "spotify");
    $("screenshareControls").classList.toggle("hidden", sourceType !== "screenshare");
  });
});

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

$("youtubeKeyHint").innerHTML = 'Searching needs a free <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API key</a> — or just paste a link here instead, no key needed.';

$("searchYoutubeBtn").addEventListener("click", () => runYoutubeSearch());
$("youtubeSearchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runYoutubeSearch(); });

async function runYoutubeSearch() {
  const query = $("youtubeSearchInput").value.trim();
  if (!query) return;
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
      resultsEl.innerHTML = `<p class="api-key-hint">Search failed: ${escapeHtml(data.error.message || "check your API key")}</p>`;
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
          socket.emit("video-action", { type: "youtube", source: videoId, isPlaying: false, currentTime: 0 });
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

function onYouTubeIframeAPIReady() {
  ytReady = true;
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function ensureYoutubePlayer(videoId, cb) {
  $("emptyState").classList.add("hidden");
  $("youtubePlayer").classList.remove("hidden");
  $("localVideoPlayer").classList.add("hidden");
  $("spotifyPlayer").classList.add("hidden");

  const create = () => {
    if (ytPlayer) {
      ytPlayer.loadVideoById(videoId);
      if (cb) cb();
      return;
    }
    ytPlayer = new YT.Player("youtubePlayer", {
      videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady: () => { if (cb) cb(); },
        onStateChange: onYoutubeStateChange,
      },
    });
  };

  if (ytReady) create();
  else setTimeout(() => ensureYoutubePlayer(videoId, cb), 300);
}

let lastYtState = null;
function onYoutubeStateChange(e) {
  if (suppressSync) return;
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-action", { type: "youtube", isPlaying: true, currentTime: ytPlayer.getCurrentTime() });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-action", { type: "youtube", isPlaying: false, currentTime: ytPlayer.getCurrentTime() });
  }
}

$("loadYoutubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrlInput").value.trim();
  const videoId = extractYoutubeId(url);
  if (!videoId) {
    alert("That doesn't look like a valid YouTube link.");
    return;
  }
  ensureYoutubePlayer(videoId, () => {
    socket.emit("video-action", { type: "youtube", source: videoId, isPlaying: false, currentTime: 0 });
  });
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
  $("emptyState").classList.add("hidden");
  $("youtubePlayer").classList.add("hidden");
  $("localVideoPlayer").classList.add("hidden");
  $("screenShareVideo").classList.add("hidden");
  $("spotifyPlayer").classList.remove("hidden");

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
        socket.emit("video-action", {
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
    socket.emit("video-action", { type: "spotify", source: `${uri.type}:${uri.id}`, isPlaying: false, currentTime: 0 });
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
  try {
    // audio: true captures tab/system sound where the browser & OS allow it —
    // in Chrome's share picker, pick the "Chrome Tab" option and tick
    // "Share tab audio" for the most reliable result. Full-desktop sharing
    // on macOS can't capture system audio at all (an OS-level limit, not
    // something any app can work around).
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    return; // user cancelled the picker
  }
  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];

  if (pc) {
    screenSender = pc.addTrack(videoTrack, screenStream);
    if (audioTrack) screenAudioSender = pc.addTrack(audioTrack, screenStream);
    renegotiate();
  }

  // Show your own screen share preview locally too.
  $("emptyState").classList.add("hidden");
  $("screenShareVideo").classList.remove("hidden");
  $("screenShareVideo").srcObject = screenStream;
  $("screenShareVideo").muted = true;
  $("screenShareLabel").textContent = audioTrack
    ? "You're sharing your screen (with sound)"
    : "You're sharing your screen (no sound captured — see tip below)";
  $("screenShareLabel").classList.remove("hidden");

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
  $("screenShareVideo").classList.add("hidden");
  $("screenShareVideo").srcObject = null;
  $("screenShareLabel").classList.add("hidden");
  $("screenShareBtn").classList.remove("active");
  $("startScreenShareBtn").textContent = "Start sharing your screen";
  if (!ytPlayer && videoEl.classList.contains("hidden") && $("spotifyPlayer").classList.contains("hidden")) {
    $("emptyState").classList.remove("hidden");
  }
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

/* ============ UPLOAD ============ */
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !roomId) return;
  $("uploadStatus").textContent = "Uploading…";
  const form = new FormData();
  form.append("video", file);
  try {
    const res = await fetch(`${SERVER_URL}/api/upload/${roomId}`, { method: "POST", body: form });
    const data = await res.json();
    if (!data.url) throw new Error("Upload failed");
    loadUploadedVideo(data.url);
    socket.emit("video-action", { type: "upload", source: data.url, isPlaying: false, currentTime: 0 });
    $("uploadStatus").textContent = `Loaded: ${data.name}`;
  } catch (err) {
    $("uploadStatus").textContent = "Upload failed. Check the server is running.";
  }
});

function loadUploadedVideo(url) {
  $("emptyState").classList.add("hidden");
  $("youtubePlayer").classList.add("hidden");
  $("spotifyPlayer").classList.add("hidden");
  const v = $("localVideoPlayer");
  v.classList.remove("hidden");
  v.src = url.startsWith("http") ? url : `${SERVER_URL}${url}`;
}

const videoEl = $("localVideoPlayer");
videoEl.addEventListener("play", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: true, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("pause", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: false, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("seeked", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: !videoEl.paused, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("timeupdate", updateFilmstripFromLocal);

/* ============ APPLY REMOTE STATE ============ */
function applyRemoteVideoState(state, isInitialSync) {
  if (!state || !state.type) return;
  suppressSync = true;

  if (state.type === "youtube") {
    if (state.source) {
      ensureYoutubePlayer(state.source, () => {
        seekAndPlayYoutube(state);
      });
    } else if (ytPlayer) {
      seekAndPlayYoutube(state);
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
    if (state.isPlaying) videoEl.play().catch(() => {});
    else videoEl.pause();
  } else if (state.type === "spotify") {
    if (state.source && spotifyController === null) {
      const [type, id] = state.source.split(":");
      ensureSpotifyPlayer({ type, id }, () => applySpotifyPlaybackState(state));
    } else if (spotifyController) {
      applySpotifyPlaybackState(state);
    }
  }

  setTimeout(() => (suppressSync = false), 400);
}

function seekAndPlayYoutube(state) {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const drift = Math.abs(ytPlayer.getCurrentTime() - (state.currentTime || 0));
  if (drift > 1.2) ytPlayer.seekTo(state.currentTime || 0, true);
  if (state.isPlaying) ytPlayer.playVideo();
  else ytPlayer.pauseVideo();
}

/* ============ FILMSTRIP SCRUBBER ============ */
function getCurrentPlaybackTime() {
  if (sourceType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  if (sourceType === "upload") return videoEl.currentTime;
  if (sourceType === "spotify") return spotifyLastPosition;
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
  const cur = getCurrentPlaybackTime();
  const isPlaying = sourceType === "upload" ? !videoEl.paused : true;
  socket.emit("video-action", { type: sourceType, isPlaying, currentTime: cur });
});

/* ============ DOUBLE-TAP REACTION ON SCREEN ============ */
document.querySelector(".screen-frame").addEventListener("dblclick", () => {
  socket.emit("reaction", { emoji: "❤️" });
  spawnFloatingEmoji("❤️");
});

initScreenShareSupport();

/* ============ PERIODIC DRIFT CORRECTION ============ */
// play/pause/seek events keep things roughly in sync, but small gaps build up
// over a few minutes (buffering, slightly different clocks, etc). Every few
// seconds each side quietly reports where it actually is, and the other side
// nudges its own position back in line if it's drifted more than ~1.5s.
setInterval(() => {
  if (!socket || !roomId) return;
  if (sourceType !== "youtube" && sourceType !== "spotify" && sourceType !== "upload") return;
  const currentTime = getCurrentPlaybackTime();
  if (!currentTime) return;
  socket.emit("sync-ping", { type: sourceType, currentTime });
}, 4000);

function applySyncPing(state) {
  if (suppressSync || state.type !== sourceType) return;
  const localTime = getCurrentPlaybackTime();
  const drift = Math.abs(localTime - (state.currentTime || 0));
  if (drift < 1.5) return;

  suppressSync = true;
  if (sourceType === "youtube" && ytPlayer && ytPlayer.seekTo) {
    ytPlayer.seekTo(state.currentTime, true);
  } else if (sourceType === "upload") {
    videoEl.currentTime = state.currentTime;
  } else if (sourceType === "spotify" && spotifyController && spotifyController.seek) {
    spotifyController.seek(state.currentTime);
  }
  setTimeout(() => (suppressSync = false), 400);
}
