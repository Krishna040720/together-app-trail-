package com.together.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Together requires this to exist and be in the foreground *before* we're
 * allowed to call MediaProjectionManager.getMediaProjection() on Android 10+
 * (and it's strictly enforced from Android 14 / API 34 onward). This is the
 * same mechanism Instagram, Zoom, and Meet use to keep screen capture alive
 * while you switch to another app — the persistent notification below is
 * mandatory, not optional; Android won't let a screen-capturing app hide it.
 *
 * This service doesn't hold the MediaProjection/VideoCapturer itself — that
 * lives in RTCClient, in the same process — it just satisfies the OS
 * requirement that a foreground service of type "mediaProjection" is running.
 */
class ScreenCaptureService : Service() {

    companion object {
        const val CHANNEL_ID = "screen_share_channel"
        const val NOTIFICATION_ID = 4201

        // Set by MainActivity right before starting this service, so the
        // notification can flip to "connected" once the service is live.
        var onServiceReady: (() -> Unit)? = null
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannelIfNeeded()
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        onServiceReady?.invoke()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
    }

    private fun createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val existing = manager.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Screen sharing",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Shows while you're sharing your screen in Together"
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sharing your screen")
            .setContentText("Together is sharing your screen with your call")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
    }
}
