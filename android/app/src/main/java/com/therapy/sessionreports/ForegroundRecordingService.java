package com.therapy.sessionreports;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.IOException;

public class ForegroundRecordingService extends Service {
    public static final String ACTION_START = "com.therapy.sessionreports.START_RECORDING";
    private static final String CHANNEL_ID = "therapy_recording";
    private static final int NOTIFICATION_ID = 401;
    private static ForegroundRecordingService activeService;

    private MediaRecorder recorder;
    private File outputFile;
    private long startedAt;
    private String lastError = "";
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            startForeground(NOTIFICATION_ID, buildNotification());
            try {
                startRecorder();
            } catch (Exception error) {
                lastError = error.getMessage() != null ? error.getMessage() : "Recording failed";
                stopSelf();
            }
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopRecorderQuietly();
        releaseWakeLock();
        activeService = null;
        super.onDestroy();
    }

    public static boolean isRecording() {
        return activeService != null && activeService.recorder != null;
    }

    public static long getStartedAt() {
        return activeService != null ? activeService.startedAt : 0;
    }

    public static long getOutputSize() {
        return activeService != null && activeService.outputFile != null && activeService.outputFile.exists()
            ? activeService.outputFile.length()
            : 0;
    }

    public static String getLastError() {
        return activeService != null ? activeService.lastError : "";
    }

    public static File stopActiveRecording() {
        if (activeService == null) {
            throw new IllegalStateException("אין הקלטה פעילה.");
        }

        File file = activeService.stopRecorder();
        activeService.stopForeground(true);
        activeService.stopSelf();
        return file;
    }

    private void startRecorder() throws IOException {
        if (recorder != null) return;

        File directory = new File(getExternalFilesDir(null), "recordings");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("לא הצלחנו ליצור תיקיית הקלטות.");
        }

        outputFile = new File(directory, "recording-" + System.currentTimeMillis() + ".m4a");
        acquireWakeLock();
        recorder = new MediaRecorder();
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        recorder.setAudioEncodingBitRate(64000);
        recorder.setAudioSamplingRate(44100);
        recorder.setOutputFile(outputFile.getAbsolutePath());
        recorder.setOnErrorListener((mr, what, extra) -> lastError = "MediaRecorder error " + what + "/" + extra);
        recorder.setOnInfoListener((mr, what, extra) -> lastError = "MediaRecorder info " + what + "/" + extra);
        recorder.prepare();
        recorder.start();
        startedAt = System.currentTimeMillis();
        lastError = "";
    }

    private File stopRecorder() {
        if (recorder == null || outputFile == null) {
            throw new IllegalStateException(lastError.isBlank() ? "אין הקלטה פעילה." : lastError);
        }

        try {
            recorder.stop();
        } finally {
            recorder.release();
            recorder = null;
            releaseWakeLock();
        }
        return outputFile;
    }

    private void stopRecorderQuietly() {
        if (recorder == null) return;
        try {
            recorder.stop();
        } catch (Exception ignored) {
        }
        recorder.release();
        recorder = null;
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TherapySessionReports:Recording");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(3 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("הקלטת פגישה פעילה")
            .setContentText("המערכת מקליטה. ניתן לכבות מסך, אבל אין לסגור את האפליקציה.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "הקלטות פגישה",
            NotificationManager.IMPORTANCE_HIGH
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }
}
