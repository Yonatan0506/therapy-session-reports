package com.therapy.sessionreports;

import java.io.File;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

final class CloudAudioTransfer {
    interface Progress { void update(int percent); }

    static HttpURLConnection connect(String address, String method) throws Exception {
        URL url = new URL(address);
        if (!"https".equals(url.getProtocol())) throw new IllegalArgumentException("HTTPS required");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(120000);
        return connection;
    }

    static void upload(File file, String address, String contentType, Progress progress) throws Exception {
        if (!"storage.googleapis.com".equals(new URL(address).getHost())) throw new IllegalArgumentException("Invalid upload host");
        long size = file.length();
        if (size <= 0) throw new IllegalArgumentException("Empty audio file");
        long offset = 0;
        int failures = 0;
        boolean probe = true;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            while (true) {
                HttpURLConnection connection = null;
                try {
                    if (probe) {
                        connection = connect(address, "PUT");
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(0);
                        connection.setRequestProperty("Content-Range", "bytes */" + size);
                        connection.getOutputStream().close();
                        int code = connection.getResponseCode();
                        if (code == 200 || code == 201) { progress.update(100); return; }
                        if (code != 308) throw new java.io.IOException("Upload status " + code);
                        long acknowledged = offset(connection.getHeaderField("Range"), size);
                        if (acknowledged > offset) failures = 0;
                        offset = acknowledged;
                        connection.disconnect();
                        connection = null;
                        probe = false;
                    }
                    long end = Math.min(offset + 4 * 1024 * 1024, size);
                    if (end <= offset) throw new java.io.IOException("Upload not finalized");
                    connection = connect(address, "PUT");
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(end - offset);
                    connection.setRequestProperty("Content-Type", contentType);
                    connection.setRequestProperty("Content-Range", "bytes " + offset + "-" + (end - 1) + "/" + size);
                    input.seek(offset);
                    try (OutputStream output = connection.getOutputStream()) {
                        byte[] buffer = new byte[65536];
                        long remaining = end - offset;
                        while (remaining > 0) {
                            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            if (read < 0) throw new java.io.IOException("Audio file truncated");
                            output.write(buffer, 0, read);
                            remaining -= read;
                        }
                    }
                    int code = connection.getResponseCode();
                    if (code == 200 || code == 201) { progress.update(100); return; }
                    if (code != 308) throw new java.io.IOException("Upload response " + code);
                    long next = offset(connection.getHeaderField("Range"), size);
                    if (next <= offset || next > end) throw new java.io.IOException("Invalid upload acknowledgement");
                    offset = next;
                    failures = 0;
                    progress.update((int) (100 * offset / size));
                } catch (Exception error) {
                    if (++failures >= 10) throw error;
                    probe = true;
                    Thread.sleep(Math.min(30000, failures * 2000L));
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        }
    }

    private static long offset(String range, long size) throws Exception {
        if (range == null) return 0;
        if (!range.matches("bytes=0-[0-9]+")) throw new java.io.IOException("Invalid range");
        long value = Long.parseLong(range.substring(8)) + 1;
        if (value < 0 || value > size) throw new java.io.IOException("Invalid offset");
        return value;
    }

    static String post(String address, String body) throws Exception {
        String host = new URL(address).getHost();
        if (!host.equals("therapy-session-reports-82786531752.me-west1.run.app")) throw new IllegalArgumentException("Invalid API host");
        HttpURLConnection connection = connect(address, "POST");
        try {
            byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) throw new java.io.IOException("Server response " + code);
            try (java.io.InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = in.read(buffer)) != -1) output.write(buffer, 0, count);
                return output.toString("UTF-8");
            }
        } finally { connection.disconnect(); }
    }
}
