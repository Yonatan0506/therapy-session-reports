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

import java.io.File;

@CapacitorPlugin(name = "NativeRecorder")
public class NativeRecorderPlugin extends Plugin {
    @PluginMethod
    public void startRecording(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("חסרה הרשאת מיקרופון. יש לאשר הרשאת Microphone לאפליקציה.");
            return;
        }

        Intent intent = new Intent(getContext(), ForegroundRecordingService.class);
        intent.setAction(ForegroundRecordingService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        JSObject result = new JSObject();
        result.put("recording", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        try {
            File file = ForegroundRecordingService.stopActiveRecording();
            JSObject result = new JSObject();
            result.put("path", file.getAbsolutePath());
            result.put("name", file.getName());
            result.put("mimeType", "audio/mp4");
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }
}
