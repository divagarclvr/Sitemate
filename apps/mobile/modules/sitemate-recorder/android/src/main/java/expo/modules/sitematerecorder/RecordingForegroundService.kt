package expo.modules.sitematerecorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * A plain foreground service of type "microphone". While it runs, Android lets the app keep
 * using the microphone with the screen locked. The actual recording is done by expo-audio;
 * this service only keeps the app allowed to record (plus a partial wake lock for long meetings).
 */
class RecordingForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopEverything()
      return START_NOT_STICKY
    }

    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Recording meeting"
    try {
      val notification = buildNotification(text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      acquireWakeLock()
      lastError = null
      running = true
    } catch (e: Exception) {
      lastError = "${e.javaClass.simpleName}: ${e.message}"
      running = false
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    running = false
    super.onDestroy()
  }

  private fun stopEverything() {
    releaseWakeLock()
    running = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  private fun buildNotification(text: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while SiteMate is recording a meeting"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }

    val openApp = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val contentIntent = openApp?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("SiteMate is recording")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SiteMate:recording").apply {
      setReferenceCounted(false)
      acquire(4 * 60 * 60 * 1000L) // safety cap: 4 hours
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  companion object {
    const val ACTION_STOP = "app.sitemate.recorder.STOP"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "sitemate_recording"
    private const val NOTIFICATION_ID = 4711

    @Volatile var running = false
    @Volatile var lastError: String? = null
  }
}
