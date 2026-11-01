package com.therapy.sessionreports;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

@CapacitorPlugin(
    name = "NativeRecorder",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone")
    }
)
public class NativeRecorderPlugin extends Plugin {
    @PluginMethod
    public void startRecording(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
            return;
        }

        startRecordingService(call);
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission denied. Please allow microphone access for this app.");
            return;
        }

        startRecordingService(call);
    }

    private void startRecordingService(PluginCall call) {
        Intent intent = new Intent(getContext(), ForegroundRecordingService.class);
        intent.setAction(ForegroundRecordingService.ACTION_START);
        intent.putExtra("sessionId", call.getString("sessionId"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        JSObject result = new JSObject();
        result.put("recording", true);
        result.put("startedAt", ForegroundRecordingService.getStartedAt());
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("recording", ForegroundRecordingService.isRecording());
        result.put("startedAt", ForegroundRecordingService.getStartedAt());
        result.put("sizeBytes", ForegroundRecordingService.getOutputSize());
        result.put("lastError", ForegroundRecordingService.getLastError());
        call.resolve(result);
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        try {
            long startedAt = ForegroundRecordingService.getStartedAt();
            File file = ForegroundRecordingService.stopActiveRecording();
            JSObject result = new JSObject();
            result.put("path", file.getAbsolutePath());
            result.put("name", file.getName());
            result.put("mimeType", "audio/mp4");
            result.put("durationMs", startedAt > 0 ? System.currentTimeMillis() - startedAt : 0);
            result.put("sizeBytes", file.exists() ? file.length() : 0);
            File manifest = ForegroundRecordingService.getLastLiveManifest();
            if (manifest != null) {
                result.put("liveManifest", manifest.getAbsolutePath());
                result.put("sessionId", LiveRecordingManifest.read(manifest).getString("sessionId"));
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void getLiveSegments(PluginCall call) {
        try {
            File manifest = new File(call.getString("path", "")).getCanonicalFile();
            String root = new File(getContext().getExternalFilesDir(null), "recordings").getCanonicalPath() + File.separator;
            if (!manifest.getPath().startsWith(root)) throw new IllegalArgumentException("Invalid recording path");
            org.json.JSONObject data = LiveRecordingManifest.read(manifest);
            org.json.JSONArray entries = data.getJSONArray("segments");
            com.getcapacitor.JSArray ids = new com.getcapacitor.JSArray();
            boolean ready = data.optBoolean("recordingComplete");
            for (int i = 0; i < entries.length(); i++) {
                org.json.JSONObject entry = entries.getJSONObject(i);
                ready = ready && entry.optBoolean("uploaded");
                if (entry.has("jobId")) ids.put(entry.getString("jobId"));
            }
            JSObject result = new JSObject();
            result.put("ready", ready && entries.length() > 0);
            result.put("segmentJobIds", ids);
            result.put("sessionId", data.getString("sessionId"));
            result.put("totalSegments", entries.length());
            call.resolve(result);
        } catch (Exception error) { call.reject("Live recording information unavailable"); }
    }
}
