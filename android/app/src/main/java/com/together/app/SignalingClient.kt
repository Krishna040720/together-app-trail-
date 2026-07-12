package com.together.app

import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONObject

/**
 * Thin wrapper around socket.io-client that speaks the exact same events as
 * client/app.js's "call" role — join-room, peer-joined, peer-left, signal —
 * so this native app can sit in the same room as server/server.js without any
 * further backend changes beyond the role-based filtering already added.
 */
class SignalingClient(
    private val serverUrl: String,
    private val roomId: String,
    private val myName: String
) {
    private var socket: Socket? = null

    var onRoomStatePeer: ((peerId: String, peerName: String) -> Unit)? = null
    var onPeerJoined: ((peerId: String, peerName: String) -> Unit)? = null
    var onPeerLeft: ((peerId: String) -> Unit)? = null
    var onSignal: ((from: String, data: JSONObject) -> Unit)? = null
    var onChatMessage: ((name: String, text: String) -> Unit)? = null
    var onConnected: (() -> Unit)? = null

    fun connect() {
        socket = IO.socket(serverUrl)
        val s = socket ?: return

        s.on(Socket.EVENT_CONNECT) {
            onConnected?.invoke()
            val payload = JSONObject().apply {
                put("roomId", roomId)
                put("name", myName)
                put("role", "call")
            }
            s.emit("join-room", payload)
        }

        s.on("room-state") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            val peers = data.optJSONArray("peers") ?: return@on
            if (peers.length() > 0) {
                val peer = peers.getJSONObject(0)
                onRoomStatePeer?.invoke(peer.optString("id"), peer.optString("name"))
            }
        }

        s.on("peer-joined") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            onPeerJoined?.invoke(data.optString("id"), data.optString("name"))
        }

        s.on("peer-left") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            onPeerLeft?.invoke(data.optString("id"))
        }

        s.on("signal") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            val from = data.optString("from")
            val payload = data.optJSONObject("data") ?: return@on
            onSignal?.invoke(from, payload)
        }

        s.on("chat-message") { args ->
            val data = args.getOrNull(0) as? JSONObject ?: return@on
            onChatMessage?.invoke(data.optString("name"), data.optString("text"))
        }

        s.connect()
    }

    fun sendSignal(to: String, data: JSONObject) {
        val payload = JSONObject().apply {
            put("to", to)
            put("data", data)
        }
        socket?.emit("signal", payload)
    }

    fun sendChatMessage(text: String) {
        val payload = JSONObject().put("text", text)
        socket?.emit("chat-message", payload)
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }

    private fun Array<Any>.getOrNull(index: Int): Any? = if (index < size) this[index] else null
}
