// Together — backend
// Handles: WebRTC signaling relay, room/media sync state, chat, reactions,
// video file uploads, and "watched together" time tracking.

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use("/uploads", express.static(UPLOAD_DIR));

// Serve the client as static files too, so you can deploy this as ONE app
// if you don't want to host front + back separately.
const CLIENT_DIR = path.join(__dirname, "..", "client");
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
}

// ---- File upload endpoint (for "upload a video/reel" sync mode) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    cb(null, safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB cap

app.post("/api/upload/:roomId", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl, name: req.file.originalname });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- In-memory room state ----
// rooms[roomId] = {
//   users: { socketId: { name } },
//   video: { type, source, isPlaying, currentTime, updatedAt },
//   chat: [ { name, text, at } ],
//   theme: 'midnight',
//   createdAt, bothJoinedAt, togetherSeconds
// }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: {},
      video: { type: null, source: null, isPlaying: false, currentTime: 0, updatedAt: Date.now() },
      chat: [],
      game: { id: null, state: null }, // whatever's currently loaded in the Games tab
      theme: "midnight",
      createdAt: Date.now(),
      bothJoinedAt: null,
      togetherSeconds: 0,
    };
  }
  return rooms[roomId];
}

function otherSocketsInRoom(roomId, excludeId) {
  return Object.keys(getRoom(roomId).users).filter((id) => id !== excludeId);
}

// "call" role = wants WebRTC (the native Android app's video/audio/screen-share
// connection). "media" role = the web client used just for chat/YouTube/Spotify/
// reactions once the native app is handling the call itself. Old web-only
// clients that never send a role are treated as "call" so nothing breaks for
// people still using this purely as a browser app.
function otherCallSocketsInRoom(roomId, excludeId) {
  const room = getRoom(roomId);
  return Object.keys(room.users).filter((id) => id !== excludeId && room.users[id].role === "call");
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on("join-room", ({ roomId, name, role }) => {
    if (!roomId) return;
    currentRoom = roomId;
    currentName = (name || "Someone").slice(0, 40);
    const myRole = role === "media" ? "media" : "call";
    socket.join(roomId);

    const room = getRoom(roomId);
    room.users[socket.id] = { name: currentName, role: myRole };

    const others = otherSocketsInRoom(roomId, socket.id);
    const callPeers = otherCallSocketsInRoom(roomId, socket.id);

    // Tell the new joiner the current state so they land in sync, not at zero.
    // "peers" here is call-role only — that's what WebRTC offer/answer needs.
    socket.emit("room-state", {
      video: room.video,
      chat: room.chat.slice(-100),
      game: room.game,
      theme: room.theme,
      peers: callPeers.map((id) => ({ id, name: room.users[id]?.name })),
    });

    // Only call-role peers need to know about each other for WebRTC purposes.
    if (myRole === "call") {
      callPeers.forEach((id) => {
        io.to(id).emit("peer-joined", { id: socket.id, name: currentName, role: myRole });
      });
    }

    if (others.length > 0 && !room.bothJoinedAt) {
      room.bothJoinedAt = Date.now();
    }
  });

  // ---- WebRTC signaling relay (offer/answer/ICE candidates) ----
  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // ---- Media sync: play / pause / seek / load-new-source ----
  socket.on("video-action", (action) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.video = {
      ...room.video,
      ...action,
      updatedAt: Date.now(),
    };
    socket.to(currentRoom).emit("video-action", room.video);
  });

  // Periodic drift-correction ping from whichever client is "source of truth"
  socket.on("sync-ping", (state) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("sync-ping", state);
  });

  // ---- Games: Tic-Tac-Toe / Connect Four / Draw & Guess ----
  // Same lightweight "trust the two people in the room" model as video-action:
  // the server just stores the latest state and relays it, all game logic
  // (whose turn, who won) is computed identically on both clients.
  socket.on("game-select", ({ id, state }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.game = { id: id || null, state: state || null };
    io.to(currentRoom).emit("game-select", room.game); // both clients init from the same payload
  });

  socket.on("game-action", (state) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room.game.id) return; // no game loaded, ignore stray actions
    room.game.state = state;
    socket.to(currentRoom).emit("game-action", state);
  });

  // Draw & Guess: strokes are ephemeral (not stored) — just like reactions,
  // they're relayed live and re-drawn on the other screen as they happen.
  socket.on("draw-stroke", (stroke) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("draw-stroke", stroke);
  });

  socket.on("draw-clear", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("draw-clear");
  });

  // ---- Chat ----
  socket.on("chat-message", ({ text }) => {
    if (!currentRoom || !text) return;
    const room = getRoom(currentRoom);
    const msg = { name: currentName, text: String(text).slice(0, 1000), at: Date.now() };
    room.chat.push(msg);
    io.to(currentRoom).emit("chat-message", msg);
  });

  // ---- Mic/camera status (so the other person sees a clear muted/off badge) ----
  socket.on("media-status", (status) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("media-status", { ...status, from: socket.id });
  });

  // ---- Reactions (floating emoji bursts) ----
  socket.on("reaction", ({ emoji }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("reaction", { emoji, from: currentName });
  });

  // ---- Moments (saved timestamp + note, shown to both) ----
  socket.on("moment", ({ note, videoTime }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("moment", { note, videoTime, name: currentName, at: Date.now() });
  });

  // ---- Ambient theme ----
  socket.on("theme-change", ({ theme }) => {
    if (!currentRoom) return;
    getRoom(currentRoom).theme = theme;
    socket.to(currentRoom).emit("theme-change", { theme });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const leavingRole = room.users[socket.id]?.role || "call";
    delete room.users[socket.id];

    if (leavingRole === "call") {
      otherCallSocketsInRoom(currentRoom, socket.id).forEach((id) => {
        io.to(id).emit("peer-left", { id: socket.id });
      });
    }

    if (Object.keys(room.users).length === 0) {
      // Keep the room around briefly in case of refresh/reconnect, then clean up.
      setTimeout(() => {
        if (rooms[currentRoom] && Object.keys(rooms[currentRoom].users).length === 0) {
          delete rooms[currentRoom];
        }
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Together server running on port ${PORT}`);
});
