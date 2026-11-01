package com.therapy.sessionreports;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public class ForegroundUploadService extends Service {
    private final java.util.concurrent.ExecutorService executor = Executors.newFixedThreadPool(2);
    private final java.util.Set<String> active = ConcurrentHashMap.newKeySet();
    private PowerManager.WakeLock wakeLock;
    private volatile int latestStartId;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        if (intent == null) return START_NOT_STICKY;
        String jobId = intent.getStringExtra("jobId");
        if (jobId == null || !active.add(jobId)) return START_REDELIVER_INTENT;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (android.os.Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel("audio-upload", "העלאת הקלטות", NotificationManager.IMPORTANCE_LOW));
        startForeground(402, new NotificationCompat.Builder(this, "audio-upload").setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("מעלה הקלטת פגישה").setContentText("ההעלאה ממשיכה ברקע").setOngoing(true).build());
        if (wakeLock == null) {
            wakeLock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TherapySessionReports:Upload");
            wakeLock.acquire(3 * 60 * 60 * 1000L);
        }
        executor.execute(() -> {
            try {
                state(jobId, "uploading", 0, "");
                if (intent.hasExtra("liveManifest")) {
                    LiveRecordingManifest.transfer(new File(intent.getStringExtra("liveManifest")));
                    state(jobId, "completed", 100, "");
                    return;
                }
                CloudAudioTransfer.upload(new File(intent.getStringExtra("path")), intent.getStringExtra("uploadUrl"), intent.getStringExtra("mimeType"), percent -> state(jobId, "uploading", percent, ""));
                Exception failure = null;
                for (int attempt = 0; attempt < 5; attempt++) {
                    try { CloudAudioTransfer.post(intent.getStringExtra("completeUrl"), "{}"); failure = null; break; }
                    catch (Exception error) { failure = error; Thread.sleep((attempt + 1) * 2000L); }
                }
                if (failure != null) throw failure;
                state(jobId, "completed", 100, "");
            } catch (Exception error) { state(jobId, "failed", 0, "ההעלאה נעצרה. נסה שוב כשהחיבור זמין."); }
            finally { active.remove(jobId); if (active.isEmpty()) stopSelfResult(latestStartId); }
        });
        return START_REDELIVER_INTENT;
    }

    private void state(String jobId, String state, int percent, String message) {
        try {
            JSONObject value = new JSONObject().put("state", state).put("percent", percent).put("message", message);
            getSharedPreferences("audio-uploads", 0).edit().putString(jobId, value.toString()).apply();
        } catch (Exception ignored) { }
    }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        executor.shutdown();
        super.onDestroy();
    }
}
