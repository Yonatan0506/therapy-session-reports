import type { TherapySession } from "./types";

const DEFAULT_REMOTE_API_BASE = "https://therapy-session-reports-82786531752.me-west1.run.app";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const AUDIO_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

export type ProcessingUpdate = {
  phase: "warming" | "uploading" | "processing";
  percent?: number;
  stage?: string;
};

export type ProcessingOptions = {
  onUpdate?: (update: ProcessingUpdate) => void;
  onJobStarted?: (jobId: string) => void;
};

export type ProcessingHealth = {
  ok: boolean;
  openai: boolean;
  ffmpeg: boolean;
  cloudStorage: boolean;
  processingMode: string;
};

export async function getProcessingHealth(): Promise<ProcessingHealth> {
  const response = await fetch(apiUrl("/api/health"), { cache: "no-store" });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json() as Promise<ProcessingHealth>;
}

export async function processAudioDraft(
  session: TherapySession,
  audioFile?: File | Blob,
  options: ProcessingOptions | ((update: ProcessingUpdate) => void) = {}
): Promise<TherapySession> {
  const { onUpdate, onJobStarted } = normalizeProcessingOptions(options);
  const file = audioFile ? normalizeAudioFile(session, audioFile) : null;
  if (file && file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES) {
    return processAudioDraftChunked(session, file, { onUpdate, onJobStarted });
  }

  const formData = new FormData();
  formData.set("session", JSON.stringify(session));
  if (file) {
    formData.set("audio", file);
  }

  let response: Response;
  try {
    onUpdate?.({ phase: "warming", stage: "warming_server" });
    await warmProcessingServer();
    onUpdate?.({ phase: "uploading", percent: 100, stage: "sending_audio" });
    response = await fetch(apiUrl("/api/process-session-job"), {
      method: "POST",
      body: formData
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` פרטים: ${error.message}` : "";
    throw new Error(`לא הצלחנו להתחבר לשרת העיבוד. בדוק שיש אינטרנט ונסה שוב בעוד דקה. אם זו הקלטה ארוכה, ודא שהמסך נשאר פתוח בזמן העלאת הקובץ.${detail}`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = payload?.message || payload?.error || "processing_failed";
    throw new Error(message);
  }

  const payload = (await response.json()) as { jobId?: string; result?: TherapySession };
  if (payload.result) return payload.result;
  if (!payload.jobId) throw new Error("לא התקבל מזהה עיבוד מהשרת.");

  onJobStarted?.(payload.jobId);
  return pollProcessingJob(payload.jobId, onUpdate);
}

async function processAudioDraftChunked(
  session: TherapySession,
  file: File,
  options: ProcessingOptions = {}
): Promise<TherapySession> {
  const { onUpdate, onJobStarted } = options;
  try {
    onUpdate?.({ phase: "warming", stage: "warming_server" });
    await warmProcessingServer();
    const startResponse = await fetch(apiUrl("/api/process-session-upload"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size
      })
    });

    const startPayload = await startResponse.json().catch(() => null);
    if (!startResponse.ok || !startPayload?.jobId) {
      throw new Error(startPayload?.message || startPayload?.error || "upload_start_failed");
    }

    const jobId = String(startPayload.jobId);
    onJobStarted?.(jobId);
    for (let offset = 0; offset < file.size; offset += AUDIO_UPLOAD_CHUNK_BYTES) {
      const chunk = file.slice(offset, Math.min(offset + AUDIO_UPLOAD_CHUNK_BYTES, file.size));
      await uploadAudioChunkWithRetry(jobId, chunk);
      onUpdate?.({
        phase: "uploading",
        percent: Math.min(100, Math.round((Math.min(offset + AUDIO_UPLOAD_CHUNK_BYTES, file.size) / file.size) * 100)),
        stage: "uploading_audio"
      });
    }

    const completeResponse = await fetch(apiUrl(`/api/process-session-upload/${encodeURIComponent(jobId)}/complete`), {
      method: "POST"
    });
    const completePayload = await completeResponse.json().catch(() => null);
    if (!completeResponse.ok) {
      throw new Error(completePayload?.message || completePayload?.error || "upload_complete_failed");
    }

    return pollProcessingJob(jobId, onUpdate);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` פרטים: ${error.message}` : "";
    throw new Error(`לא הצלחנו להעלות את ההקלטה הארוכה לשרת העיבוד.${detail}`);
  }
}

async function uploadAudioChunkWithRetry(jobId: string, chunk: Blob) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(apiUrl(`/api/process-session-upload/${encodeURIComponent(jobId)}/chunk`), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || payload?.error || `chunk_upload_failed_${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await delay(1000 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("chunk_upload_failed");
}

export async function resumeProcessingJob(
  jobId: string,
  onUpdate?: (update: ProcessingUpdate) => void
): Promise<TherapySession> {
  return pollProcessingJob(jobId, onUpdate);
}

async function pollProcessingJob(jobId: string, onUpdate?: (update: ProcessingUpdate) => void): Promise<TherapySession> {
  const startedAt = Date.now();
  const timeoutMs = 90 * 60 * 1000;
  let transientFailures = 0;
  const maxTransientFailures = 60;

  while (Date.now() - startedAt < timeoutMs) {
    await delay(4000);
    let response: Response;
    let payload: any = null;

    try {
      response = await fetch(apiUrl(`/api/process-session-job/${encodeURIComponent(jobId)}`), { cache: "no-store" });
      payload = await response.json().catch(() => null);
      transientFailures = 0;
      if (payload?.status && payload.status !== "completed") {
        onUpdate?.({ phase: "processing", stage: payload.stage || payload.status });
      }
    } catch (error) {
      transientFailures += 1;
      if (transientFailures > maxTransientFailures) {
        const detail = error instanceof Error && error.message ? ` פרטים: ${error.message}` : "";
        throw new Error(`העיבוד עדיין לא הסתיים, אבל החיבור לבדיקת הסטטוס נפל שוב ושוב.${detail}`);
      }
      continue;
    }

    if (response.ok && payload?.status === "completed" && payload.result) {
      return payload.result as TherapySession;
    }

    if (payload?.status === "failed") {
      throw new Error(payload?.message || payload?.error || "processing_failed");
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(payload?.message || "עבודת העיבוד לא נמצאה. ייתכן שהשרת הופעל מחדש בזמן העיבוד.");
      }
      transientFailures += 1;
      if (transientFailures > maxTransientFailures) {
        throw new Error(payload?.message || payload?.error || `בדיקת סטטוס העיבוד נכשלה שוב ושוב (${response.status}).`);
      }
    }
  }

  throw new Error("העיבוד נמשך יותר מדי זמן. אם סימנת שמירת אודיו, הקובץ נשמר ב-Google Drive ואפשר לנסות שוב מאוחר יותר.");
}

function normalizeProcessingOptions(options: ProcessingOptions | ((update: ProcessingUpdate) => void)): ProcessingOptions {
  if (typeof options === "function") return { onUpdate: options };
  return options;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function warmProcessingServer() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(apiUrl("/api/health"), {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`health ${response.status}`);
  } finally {
    window.clearTimeout(timeout);
  }
}

function apiUrl(path: string) {
  const base = API_BASE_URL || (isNativeOrFileOrigin() ? DEFAULT_REMOTE_API_BASE : "");
  return base ? `${base}${path}` : path;
}

function isNativeOrFileOrigin() {
  return window.location.protocol === "capacitor:" || window.location.protocol === "file:";
}

function normalizeAudioFile(session: TherapySession, audioFile: File | Blob) {
  if (audioFile instanceof File && audioFile.name) return audioFile;
  return new File([audioFile], `recording-${session.sessionId}.${audioExtensionFromMime(audioFile.type)}`, {
    type: audioFile.type || "audio/webm"
  });
}

function audioExtensionFromMime(mimeType: string) {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  return "webm";
}

export async function askSessionQuestion(payload: {
  question: string;
  session: TherapySession;
  previousSessions?: TherapySession[];
}): Promise<string> {
  const response = await fetch(apiUrl("/api/chat-session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("chat_failed");
  }

  const data = (await response.json()) as { answer: string };
  return data.answer;
}

export async function createProgressSummary(payload: {
  patientDisplayName: string;
  dateFrom: string;
  dateTo: string;
  sessions: TherapySession[];
}): Promise<string> {
  const response = await fetch(apiUrl("/api/progress-summary"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message || data?.error || "progress_summary_failed");
  }

  const data = (await response.json()) as { summary: string };
  return data.summary;
}
