export type UploadCheckpoint = { jobId: string; nextChunk: number; updatedAt: number };

export async function uploadCheckpointKey(sessionId: string, file: File) {
  const sample = new Blob([file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]);
  const digest = await crypto.subtle.digest("SHA-256", await sample.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `audio-upload-v2:${sessionId}:${file.size}:${hash}`;
}

export function readUploadCheckpoint(key: string, totalChunks: number): UploadCheckpoint | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (!value || typeof value.jobId !== "string" || !Number.isInteger(value.nextChunk) ||
        value.nextChunk < 0 || value.nextChunk > totalChunks ||
        !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > 60 * 60 * 1000) return null;
    return value;
  } catch { return null; }
}

export function saveUploadCheckpoint(key: string, jobId: string, nextChunk: number) {
  try { localStorage.setItem(key, JSON.stringify({ jobId, nextChunk, updatedAt: Date.now() })); } catch { /* Uploads still work when browser storage is unavailable. */ }
}

export function clearUploadCheckpoint(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage can be disabled. */ }
}
