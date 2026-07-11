package com.together.app

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.PeerConnection.*

/**
 * Wraps the real WebRTC Android SDK (io.github.webrtc-sdk:android — the
 * actively-maintained build of Google's WebRTC) to provide:
 *  - a camera + mic call (equivalent to the browser app's WebRTC logic)
 *  - screen sharing as a SECOND video track added to the same connection,
 *    so the camera keeps running the whole time — same "don't close the
 *    camera" behavior as the web app's screen share, but using
 *    ScreenCapturerAndroid, which (unlike a browser tab) keeps capturing
 *    even while you're in another app, as long as ScreenCaptureService's
 *    foreground notification is alive.
 *
 * NOTE: this is a real, structurally complete starting point, but it hasn't
 * been compiled/run on a device (this environment has no Android SDK). Treat
 * it as ~90% of the way there — expect to fix small API mismatches once you
 * open this in Android Studio, especially around whichever exact WebRTC SDK
 * version you end up pulling in.
 */
class RTCClient(
    private val appContext: Context,
    private val eglBase: EglBase,
    private val signaling: SignalingClient
) {
    // STUN alone fails on strict networks. Get free TURN credentials at
    // https://www.metered.ca/tools/openrelay/ (dashboard.metered.ca) and
    // paste them below — same service the web app uses, so both stay
    // equally reliable on tricky networks.
    private val turnUsername = "" // fill in from your Metered.ca dashboard
    private val turnCredential = ""

    private val iceServers: List<IceServer> by lazy {
        val servers = mutableListOf(
            IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )
        if (turnUsername.isNotBlank() && turnCredential.isNotBlank()) {
            servers += IceServer.builder("stun:stun.relay.metered.ca:80").createIceServer()
            servers += IceServer.builder("turn:standard.relay.metered.ca:80")
                .setUsername(turnUsername).setPassword(turnCredential).createIceServer()
            servers += IceServer.builder("turn:standard.relay.metered.ca:443")
                .setUsername(turnUsername).setPassword(turnCredential).createIceServer()
            servers += IceServer.builder("turns:standard.relay.metered.ca:443?transport=tcp")
                .setUsername(turnUsername).setPassword(turnCredential).createIceServer()
        }
        servers
    }

    private lateinit var factory: PeerConnectionFactory
    private var peerConnection: PeerConnection? = null
    private var remoteId: String? = null

    // Camera + mic
    private var videoCapturer: CameraVideoCapturer? = null
    private var localVideoTrack: VideoTrack? = null
    private var localVideoSource: VideoSource? = null

    // Screen share (second track, added later)
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenVideoTrack: VideoTrack? = null
    private var screenSender: RtpSender? = null
    private var mediaProjection: MediaProjection? = null

    var onRemoteVideoTrack: ((VideoTrack) -> Unit)? = null
    var onScreenShareEnded: (() -> Unit)? = null

    fun init() {
        val options = PeerConnectionFactory.InitializationOptions.builder(appContext)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(options)

        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    /** Starts camera + mic capture and returns the local track so the caller can render it. */
    fun startLocalMedia(localRenderer: SurfaceViewRenderer): VideoTrack {
        localRenderer.init(eglBase.eglBaseContext, null)

        val surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
        videoCapturer = createCameraCapturer()
        localVideoSource = factory.createVideoSource(false)
        videoCapturer?.initialize(surfaceTextureHelper, appContext, localVideoSource!!.capturerObserver)
        videoCapturer?.startCapture(1280, 720, 30)

        val videoTrack = factory.createVideoTrack("local_video", localVideoSource)
        videoTrack.addSink(localRenderer)
        localVideoTrack = videoTrack

        val audioConstraints = MediaConstraints()
        val audioSource = factory.createAudioSource(audioConstraints)
        val audioTrack = factory.createAudioTrack("local_audio", audioSource)

        createPeerConnectionIfNeeded()
        val videoSender = peerConnection?.addTrack(videoTrack, listOf("call_stream"))
        peerConnection?.addTrack(audioTrack, listOf("call_stream"))
        boostVideoBitrate(videoSender)

        return videoTrack
    }

    /** Raises the default (fairly conservative) bitrate ceiling for a clearer call on good connections. */
    private fun boostVideoBitrate(sender: RtpSender?) {
        sender ?: return
        val params = sender.parameters
        if (params.encodings.isNotEmpty()) {
            params.encodings[0].maxBitrateBps = 2_500_000 // ~720p territory
            sender.parameters = params
        }
    }

    private fun createCameraCapturer(): CameraVideoCapturer {
        val enumerator = Camera2Enumerator(appContext)
        val frontCamera = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.first()
        return enumerator.createCapturer(frontCamera, null)
    }

    private fun createPeerConnectionIfNeeded() {
        if (peerConnection != null) return

        val rtcConfig = RTCConfiguration(iceServers).apply {
            sdpSemantics = SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = factory.createPeerConnection(rtcConfig, object : Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                val target = remoteId ?: return
                val payload = JSONObject().apply {
                    put("candidate", JSONObject().apply {
                        put("candidate", candidate.sdp)
                        put("sdpMid", candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                    })
                }
                signaling.sendSignal(target, payload)
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track()
                if (track is VideoTrack) {
                    onRemoteVideoTrack?.invoke(track)
                }
            }

            override fun onRenegotiationNeeded() {
                // Only renegotiate once we actually have someone to talk to —
                // this also fires for the very first camera/mic tracks, which
                // is handled by the normal call()/answer offer/answer flow instead.
                if (remoteId != null && screenSender != null) {
                    createAndSendOffer()
                }
            }

            override fun onIceConnectionChange(state: IceConnectionState) {}
            override fun onConnectionChange(state: PeerConnectionState) {}
            override fun onIceGatheringChange(state: IceGatheringState) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) {}
            override fun onSignalingChange(state: SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        })
    }

    fun setRemotePeer(id: String) {
        remoteId = id
    }

    /** Call this when we're the one who was already in the room (mirrors web app.js's behavior). */
    fun createAndSendOffer() {
        val constraints = MediaConstraints()
        peerConnection?.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                peerConnection?.setLocalDescription(SdpObserverAdapter(), desc)
                val target = remoteId ?: return
                signaling.sendSignal(target, sdpToJson(desc))
            }
        }, constraints)
    }

    fun handleRemoteSignal(from: String, data: JSONObject) {
        remoteId = from
        createPeerConnectionIfNeeded()

        when {
            data.has("type") && data.optString("type") == "offer" -> {
                val desc = SessionDescription(SessionDescription.Type.OFFER, data.optString("sdp"))
                peerConnection?.setRemoteDescription(SdpObserverAdapter(), desc)
                peerConnection?.createAnswer(object : SdpObserverAdapter() {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        peerConnection?.setLocalDescription(SdpObserverAdapter(), answer)
                        signaling.sendSignal(from, sdpToJson(answer))
                    }
                }, MediaConstraints())
            }
            data.has("type") && data.optString("type") == "answer" -> {
                val desc = SessionDescription(SessionDescription.Type.ANSWER, data.optString("sdp"))
                peerConnection?.setRemoteDescription(SdpObserverAdapter(), desc)
            }
            data.has("candidate") -> {
                val c = data.optJSONObject("candidate") ?: return
                val candidate = IceCandidate(
                    c.optString("sdpMid"),
                    c.optInt("sdpMLineIndex"),
                    c.optString("candidate")
                )
                peerConnection?.addIceCandidate(candidate)
            }
        }
    }

    // ---------------- Screen share ----------------

    /**
     * Call after MainActivity gets a successful screen-capture permission
     * result AND has confirmed ScreenCaptureService is in the foreground.
     */
    fun startScreenShare(resultCode: Int, data: Intent, localScreenRenderer: SurfaceViewRenderer?) {
        val projectionManager =
            appContext.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = projectionManager.getMediaProjection(resultCode, data)

        val surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCaptureThread", eglBase.eglBaseContext)
        screenCapturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() {
                stopScreenShare()
                onScreenShareEnded?.invoke()
            }
        })

        val screenSource = factory.createVideoSource(true) // isScreencast = true
        screenCapturer?.initialize(surfaceTextureHelper, appContext, screenSource.capturerObserver)
        screenCapturer?.startCapture(1080, 2400, 30)

        val track = factory.createVideoTrack("screen_video", screenSource)
        localScreenRenderer?.let {
            it.init(eglBase.eglBaseContext, null)
            track.addSink(it)
        }
        screenVideoTrack = track
        screenSender = peerConnection?.addTrack(track, listOf("screen_stream"))
        // onRenegotiationNeeded fires from the addTrack call above and will
        // send a fresh offer since screenSender is now non-null.
    }

    fun stopScreenShare() {
        screenSender?.let { peerConnection?.removeTrack(it) }
        screenSender = null
        screenCapturer?.stopCapture()
        screenCapturer?.dispose()
        screenCapturer = null
        screenVideoTrack = null
        mediaProjection?.stop()
        mediaProjection = null
        if (remoteId != null) createAndSendOffer()
    }

    fun toggleMic(enabled: Boolean) {
        peerConnection?.senders?.forEach { sender ->
            if (sender.track()?.kind() == "audio") sender.track()?.setEnabled(enabled)
        }
    }

    fun toggleCamera(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
    }

    fun close() {
        videoCapturer?.stopCapture()
        screenCapturer?.stopCapture()
        peerConnection?.close()
        peerConnection = null
    }

    private fun sdpToJson(desc: SessionDescription): JSONObject {
        return JSONObject().apply {
            put("type", if (desc.type == SessionDescription.Type.OFFER) "offer" else "answer")
            put("sdp", desc.description)
        }
    }
}

/** SdpObserver has more callbacks than we usually care about — this fills in no-ops. */
open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(p0: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(p0: String?) {}
    override fun onSetFailure(p0: String?) {}
}
