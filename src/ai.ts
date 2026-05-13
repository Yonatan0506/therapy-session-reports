import type { TherapySession } from "./types";

const DEFAULT_REMOTE_API_BASE = "https://therapy-session-reports.onrender.com";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");

export async function processAudioDraft(session: TherapySession, audioFile?: File | Blob): Promise<TherapySession> {
  const formData = new FormData();
  formData.set("session", JSON.stringify(session));
  if (audioFile) {
    const file =
      audioFile instanceof File
        ? audioFile
        : new File([audioFile], `recording-${session.sessionId}.${audioExtensionFromMime(audioFile.type)}`, {
            type: audioFile.type || "audio/webm"
          });
    formData.set("audio", file);
  }

  let response: Response;
  try {
    await warmProcessingServer();
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

  return pollProcessingJob(payload.jobId);
}

async function pollProcessingJob(jobId: string): Promise<TherapySession> {
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
