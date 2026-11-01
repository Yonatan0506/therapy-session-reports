package com.therapy.sessionreports;

import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

final class LiveRecordingManifest {
    static synchronized JSONObject read(File file) throws Exception {
        return new JSONObject(new String(new AtomicFile(file).readFully(), StandardCharsets.UTF_8));
    }

    static synchronized void write(File file, JSONObject value) throws Exception {
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream stream = atomic.startWrite();
        try { stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(stream); }
        catch (Exception error) { atomic.failWrite(stream); throw error; }
    }

    static synchronized void add(File file, File audio) throws Exception {
        JSONObject value = read(file);
        value.getJSONArray("segments").put(new JSONObject().put("path", audio.getAbsolutePath()));
        write(file, value);
    }

    static synchronized void update(File file, int index, JSONObject entry) throws Exception {
        JSONObject value = read(file);
        value.getJSONArray("segments").put(index, entry);
        write(file, value);
    }

    static synchronized void complete(File file) throws Exception {
        JSONObject value = read(file).put("recordingComplete", true);
        write(file, value);
    }

    static void transfer(File manifest) throws Exception {
        final String api = "https://therapy-session-reports-82786531752.me-west1.run.app";
        int index = 0;
        long deadline = System.currentTimeMillis() + 3 * 60 * 60 * 1000L;
        while (System.currentTimeMillis() < deadline) {
            JSONObject value = read(manifest);
            JSONArray segments = value.getJSONArray("segments");
            if (index >= segments.length()) {
                if (value.optBoolean("recordingComplete")) return;
                Thread.sleep(1000);
                continue;
            }
            JSONObject entry = segments.getJSONObject(index);
            if (entry.optBoolean("uploaded")) { index++; continue; }
            File audio = new File(entry.getString("path"));
            int failures = 0;
            while (!entry.optBoolean("uploaded")) {
                try {
                    if (!entry.has("jobId")) {
                        JSONObject request = new JSONObject().put("session", new JSONObject().put("sessionId", value.getString("sessionId")))
                            .put("fileName", audio.getName()).put("size", audio.length()).put("mimeType", "audio/mp4")
                            .put("transport", "resumable").put("transcriptOnly", true);
                        JSONObject response = new JSONObject(CloudAudioTransfer.post(api + "/api/process-session-upload", request.toString()));
                        entry.put("jobId", response.getString("jobId")).put("uploadUrl", response.getString("uploadUrl"));
                        update(manifest, index, entry);
                    }
                    CloudAudioTransfer.upload(audio, entry.getString("uploadUrl"), "audio/mp4", percent -> { });
                    CloudAudioTransfer.post(api + "/api/process-session-upload/" + entry.getString("jobId") + "/complete", "{}");
                    entry.put("uploaded", true);
                    entry.remove("uploadUrl");
                    update(manifest, index, entry);
                } catch (Exception error) {
                    failures++;
                    if (System.currentTimeMillis() >= deadline) throw error;
                    Thread.sleep(15000);
                }
            }
            index++;
        }
        throw new java.io.IOException("Live upload waiting for connection");
    }
}
