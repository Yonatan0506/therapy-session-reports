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
    private File nextFile;
    private File liveManifest;
    private final java.util.List<File> segmentFiles = new java.util.ArrayList<>();
    private static File lastLiveManifest;

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
                startRecorder(intent.getStringExtra("sessionId"));
            } catch (Exception error) {
                lastError = error.getMessage() != null ? error.getMessage() : "Recording failed";
                if (liveManifest != null) {
                    try { LiveRecordingManifest.complete(liveManifest); } catch (Exception ignored) { }
                }
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

        ForegroundRecordingService service = activeService;
        try { return service.stopRecorder(); }
        finally { service.stopForeground(true); service.stopSelf(); }
    }

    public static File getLastLiveManifest() { return lastLiveManifest; }

    private void startRecorder(String sessionId) throws Exception {
        if (recorder != null) return;

        File directory = new File(getExternalFilesDir(null), "recordings");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("לא הצלחנו ליצור תיקיית הקלטות.");
        }

        if (sessionId != null && sessionId.matches("[a-fA-F0-9-]{36}")) {
            directory = new File(directory, sessionId);
            directory.mkdirs();
            liveManifest = new File(directory, "live.json");
            LiveRecordingManifest.write(liveManifest, new org.json.JSONObject().put("sessionId", sessionId)
                .put("recordingComplete", false).put("segments", new org.json.JSONArray()));
            lastLiveManifest = liveManifest;
            Intent upload = new Intent(this, ForegroundUploadService.class);
            upload.putExtra("jobId", sessionId).putExtra("liveManifest", liveManifest.getAbsolutePath());
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(upload); else startService(upload);
        } else { lastLiveManifest = null; }
        outputFile = new File(directory, "recording-" + System.currentTimeMillis() + ".m4a");
        segmentFiles.clear();
        segmentFiles.add(outputFile);
        acquireWakeLock();
        recorder = new MediaRecorder();
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        recorder.setAudioEncodingBitRate(64000);
        recorder.setAudioChannels(1);
        recorder.setAudioSamplingRate(44100);
        recorder.setOutputFile(outputFile.getAbsolutePath());
        recorder.setOnErrorListener((mr, what, extra) -> lastError = "MediaRecorder error " + what + "/" + extra);
        if (liveManifest != null && Build.VERSION.SDK_INT >= 26) recorder.setMaxFileSize(1024 * 1024);
        recorder.setOnInfoListener((mr, what, extra) -> {
            try {
                if (liveManifest != null && Build.VERSION.SDK_INT >= 26 && what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING) {
                    nextFile = new File(outputFile.getParentFile(), "recording-" + System.currentTimeMillis() + ".m4a");
                    mr.setNextOutputFile(nextFile);
                } else if (liveManifest != null && what == MediaRecorder.MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED) {
                    LiveRecordingManifest.add(liveManifest, outputFile);
                    outputFile = nextFile;
                    nextFile = null;
                    segmentFiles.add(outputFile);
                } else if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) {
                    lastError = "Recording reached its file limit before switching segments";
                }
            } catch (Exception error) { lastError = "Could not prepare recording segment"; }
        });
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
        if (liveManifest != null) {
            try {
                LiveRecordingManifest.add(liveManifest, outputFile);
                LiveRecordingManifest.complete(liveManifest);
                if (segmentFiles.size() > 1) return mergeSegments();
            } catch (Exception error) { throw new IllegalStateException("ההקלטות נשמרו, אך איחוד האודיו נכשל.", error); }
        }
        return outputFile;
    }

    private File mergeSegments() throws Exception {
        File merged = new File(outputFile.getParentFile(), "full-recording.m4a");
        android.media.MediaMuxer muxer = new android.media.MediaMuxer(merged.getAbsolutePath(), android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        boolean started = false;
        int outputTrack = -1;
        long nextTimestamp = 0;
        try {
            java.nio.ByteBuffer buffer = java.nio.ByteBuffer.allocate(1024 * 1024);
            for (File segment : segmentFiles) {
                android.media.MediaExtractor extractor = new android.media.MediaExtractor();
                try {
                    extractor.setDataSource(segment.getAbsolutePath());
                    int inputTrack = -1;
                    for (int i = 0; i < extractor.getTrackCount(); i++) {
                        android.media.MediaFormat format = extractor.getTrackFormat(i);
                        if (format.getString(android.media.MediaFormat.KEY_MIME).startsWith("audio/")) {
                            inputTrack = i;
                            if (!started) { outputTrack = muxer.addTrack(format); muxer.start(); started = true; }
                            break;
                        }
                    }
                    if (inputTrack < 0) throw new IOException("Audio track missing");
                    extractor.selectTrack(inputTrack);
                    long base = extractor.getSampleTime();
                    long last = nextTimestamp;
                    while (true) {
                        buffer.clear();
                        int size = extractor.readSampleData(buffer, 0);
                        if (size < 0) break;
                        android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
                        long time = nextTimestamp + Math.max(0, extractor.getSampleTime() - base);
                        info.set(0, size, time, extractor.getSampleFlags());
                        muxer.writeSampleData(outputTrack, buffer, info);
                        last = time;
                        extractor.advance();
                    }
                    nextTimestamp = last + 23220;
                } finally { extractor.release(); }
            }
        } finally { if (started) muxer.stop(); muxer.release(); }
        return merged;
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
