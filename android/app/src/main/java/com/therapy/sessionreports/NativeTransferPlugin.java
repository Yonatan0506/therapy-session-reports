package com.therapy.sessionreports;

import android.content.Intent;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "NativeTransfer")
public class NativeTransferPlugin extends Plugin {
    @PluginMethod
    public void stage(PluginCall call) {
        getBridge().execute(() -> {
            try {
                String name = call.getString("name", "");
                if (!name.matches("[a-fA-F0-9-]+\\.audio")) throw new IllegalArgumentException("Invalid audio name");
                File directory = new File(getContext().getFilesDir(), "upload-audio");
                directory.mkdirs();
                File file = new File(directory, name);
                try (FileOutputStream out = new FileOutputStream(file, call.getBoolean("append", false))) {
                    out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
                }
                JSObject result = new JSObject(); result.put("path", file.getAbsolutePath()); call.resolve(result);
            } catch (Exception error) { call.reject("Could not stage audio"); }
        });
    }

    @PluginMethod
    public void upload(PluginCall call) {
        try {
            File file = new File(call.getString("path", "")).getCanonicalFile();
            String internal = new File(getContext().getFilesDir(), "upload-audio").getCanonicalPath() + File.separator;
            String external = new File(getContext().getExternalFilesDir(null), "recordings").getCanonicalPath() + File.separator;
            if ((!file.getPath().startsWith(internal) && !file.getPath().startsWith(external)) || !file.isFile()) throw new IllegalArgumentException("Invalid audio path");
            String jobId = call.getString("jobId", "");
            if (!jobId.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("Invalid job");
            Intent intent = new Intent(getContext(), ForegroundUploadService.class);
            intent.putExtra("path", file.getPath());
            intent.putExtra("jobId", jobId);
            intent.putExtra("uploadUrl", call.getString("uploadUrl"));
            intent.putExtra("completeUrl", call.getString("completeUrl"));
            intent.putExtra("mimeType", call.getString("mimeType", "application/octet-stream"));
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Could not start background upload: " + error.getMessage()); }
    }

    @PluginMethod
    public void status(PluginCall call) {
        String raw = getContext().getSharedPreferences("audio-uploads", 0).getString(call.getString("jobId", ""), "");
        try { call.resolve(raw.isEmpty() ? new JSObject().put("state", "queued") : new JSObject(raw)); }
        catch (Exception error) { call.reject("Upload status unavailable"); }
    }
}
