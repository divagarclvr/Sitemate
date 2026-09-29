package expo.modules.sitematerecorder

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SitemateRecorderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SitemateRecorder")

    /** Starts the microphone foreground service; resolves once it is running, or rejects with the reason. */
    AsyncFunction("startForegroundService") { text: String ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "App context is not available", null)
      val intent = Intent(context, RecordingForegroundService::class.java).putExtra(RecordingForegroundService.EXTRA_TEXT, text)

      RecordingForegroundService.lastError = null
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: Exception) {
        throw CodedException("FGS_START_REFUSED", "${e.javaClass.simpleName}: ${e.message}", e)
      }
      waitUntilRunning()
    }

    AsyncFunction("stopForegroundService") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(context, RecordingForegroundService::class.java).setAction(RecordingForegroundService.ACTION_STOP)
      try {
        context.startService(intent)
      } catch (_: Exception) {
        context.stopService(Intent(context, RecordingForegroundService::class.java))
      }
      true
    }

    Function("isRunning") {
      RecordingForegroundService.running
    }
  }

  private fun waitUntilRunning(): Boolean {
    // onStartCommand runs on the main thread shortly after the start request.
    repeat(30) {
      if (RecordingForegroundService.running) return true
      RecordingForegroundService.lastError?.let { throw CodedException("FGS_FAILED", it, null) }
      Thread.sleep(100)
    }
    throw CodedException("FGS_TIMEOUT", "The recording service did not start within 3 seconds", null)
  }
}
