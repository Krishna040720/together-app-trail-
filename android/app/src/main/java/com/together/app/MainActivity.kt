package com.together.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * NOTE: this file assumes the standard Android view IDs from
 * activity_main.xml (joinForm, nameInput, serverUrlInput, roomInput,
 * startBtn, callFrame, remoteRenderer, localRenderer, screenPreviewRenderer,
 * controlsRow, micBtn, cameraBtn, screenShareBtn, leaveBtn, webView).
 * It hasn't been compiled on a real Android SDK — expect to fix small things
 * (exact WebRTC SDK API surface, permission edge cases) once you open this
 * in Android Studio.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var eglBase: EglBase
    private lateinit var signaling: SignalingClient
    private lateinit var rtcClient: RTCClient

    private var micEnabled = true
    private var cameraEnabled = true
    private var screenSharing = false

    private val requiredPermissions = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.all { it }) {
            beginCall()
        } else {
            android.widget.Toast.makeText(
                this,
                "Camera and mic permissions are needed for the call to work.",
                android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            ScreenCaptureService.onServiceReady = {
                runOnUiThread {
                    val screenView = findViewById<org.webrtc.SurfaceViewRenderer>(R.id.screenPreviewRenderer)
                    screenView.visibility = View.VISIBLE
                    rtcClient.startScreenShare(result.resultCode, data, screenView)
                    screenSharing = true
                }
            }
            val serviceIntent = Intent(this, ScreenCaptureService::class.java)
            ContextCompat.startForegroundService(this, serviceIntent)
        } else {
            android.widget.Toast.makeText(this, "Screen share was cancelled.", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        eglBase = EglBase.create()

        applyRoundedCorners()

        findViewById<android.widget.Button>(R.id.startBtn).setOnClickListener {
            requestPermissionsAndStart()
        }
    }

    /** Matches the web app's rounded-square call tiles (border-radius: 28px there). */
    private fun applyRoundedCorners() {
        val radiusPx = resources.displayMetrics.density * 20f
        val provider = object : android.view.ViewOutlineProvider() {
            override fun getOutline(view: View, outline: android.graphics.Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
            }
        }
        listOf(R.id.localRenderer, R.id.remoteRenderer, R.id.screenPreviewRenderer).forEach { id ->
            findViewById<View>(id).apply {
                outlineProvider = provider
                clipToOutline = true
            }
        }
    }

    private fun requestPermissionsAndStart() {
        val notGranted = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (notGranted.isEmpty()) beginCall() else permissionLauncher.launch(notGranted.toTypedArray())
    }

    private fun beginCall() {
        val name = findViewById<android.widget.EditText>(R.id.nameInput).text.toString().ifBlank { "Someone" }
        val serverUrl = findViewById<android.widget.EditText>(R.id.serverUrlInput).text.toString().trim()
        var roomCode = findViewById<android.widget.EditText>(R.id.roomInput).text.toString()
            .trim().lowercase().replace(Regex("\\s+"), "-")

        if (serverUrl.isBlank()) {
            android.widget.Toast.makeText(this, "Paste your deployed server URL first.", android.widget.Toast.LENGTH_LONG).show()
            return
        }
        if (roomCode.isBlank()) {
            roomCode = "room-" + (1000..9999).random()
        }

        findViewById<View>(R.id.joinForm).visibility = View.GONE
        findViewById<View>(R.id.callFrame).visibility = View.VISIBLE
        findViewById<View>(R.id.controlsRow).visibility = View.VISIBLE

        setUpWebView(serverUrl, roomCode, name)
        setUpCall(serverUrl, roomCode, name)
        wireControlButtons()
    }

    private fun setUpWebView(serverUrl: String, roomCode: String, name: String) {
        val webView = findViewById<WebView>(R.id.webView)
        webView.visibility = View.VISIBLE
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webChromeClient = WebChromeClient()

        val encodedName = java.net.URLEncoder.encode(name, "UTF-8")
        val url = "$serverUrl/?native=1&room=$roomCode&name=$encodedName"
        webView.loadUrl(url)
    }

    private fun setUpCall(serverUrl: String, roomCode: String, name: String) {
        rtcClient = RTCClient(applicationContext, eglBase, SignalingClient(serverUrl, roomCode, name).also { signaling = it })
        rtcClient.init()

        val localRenderer = findViewById<org.webrtc.SurfaceViewRenderer>(R.id.localRenderer)
        val remoteRenderer = findViewById<org.webrtc.SurfaceViewRenderer>(R.id.remoteRenderer)
        remoteRenderer.init(eglBase.eglBaseContext, null)

        rtcClient.startLocalMedia(localRenderer)

        rtcClient.onRemoteVideoTrack = { track: VideoTrack ->
            runOnUiThread { track.addSink(remoteRenderer) }
        }
        rtcClient.onScreenShareEnded = {
            runOnUiThread {
                findViewById<View>(R.id.screenPreviewRenderer).visibility = View.GONE
                screenSharing = false
            }
        }

        signaling.onRoomStatePeer = { id, _ -> rtcClient.setRemotePeer(id) } // wait for their offer
        signaling.onPeerJoined = { id, _ ->
            rtcClient.setRemotePeer(id)
            rtcClient.createAndSendOffer() // we were already here — we initiate
        }
        signaling.onSignal = { from, data -> rtcClient.handleRemoteSignal(from, data) }
        signaling.onPeerLeft = {
            runOnUiThread {
                findViewById<org.webrtc.SurfaceViewRenderer>(R.id.remoteRenderer).clearImage()
            }
        }
        signaling.connect()
    }

    private fun wireControlButtons() {
        findViewById<android.widget.ImageButton>(R.id.micBtn).setOnClickListener {
            micEnabled = !micEnabled
            rtcClient.toggleMic(micEnabled)
        }
        findViewById<android.widget.ImageButton>(R.id.cameraBtn).setOnClickListener {
            cameraEnabled = !cameraEnabled
            rtcClient.toggleCamera(cameraEnabled)
        }
        findViewById<android.widget.ImageButton>(R.id.screenShareBtn).setOnClickListener {
            if (screenSharing) {
                rtcClient.stopScreenShare()
                findViewById<View>(R.id.screenPreviewRenderer).visibility = View.GONE
                screenSharing = false
            } else {
                val projectionManager =
                    getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
            }
        }
        findViewById<android.widget.ImageButton>(R.id.leaveBtn).setOnClickListener {
            finish()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::rtcClient.isInitialized) rtcClient.close()
        if (::signaling.isInitialized) signaling.disconnect()
        eglBase.release()
    }
}
