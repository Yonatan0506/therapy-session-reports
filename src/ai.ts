import type { TherapySession } from "./types";

export async function processAudioDraft(session: TherapySession, audioFile?: File | Blob): Promise<TherapySession> {
  const formData = new FormData();
  formData.set("session", JSON.stringify(session));
  if (audioFile) {
    const file =
      audioFile instanceof File
        ? audioFile
        : new File([audioFile], `recording-${session.sessionId}.webm`, { type: audioFile.type || "audio/webm" });
    formData.set("audio", file);
  }

  let response: Response;
  try {
    response = await fetch("/api/process-session-job", {
      method: "POST",
      body: formData
    });
  } catch {
    throw new Error("לא הצלחנו להתחבר לשרת העיבוד. בדוק חיבור אינטרנט, המתן רגע ונסה שוב. אם זו הקלטה ארוכה, מומלץ לוודא שהטלפון לא במצב חיסכון בסוללה.");
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
  const timeoutMs = 45 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await delay(4000);
    const response = await fetch(`/api/process-session-job/${encodeURIComponent(jobId)}`);
    const payload = await response.json().catch(() => null);

    if (response.ok && payload?.status === "completed" && payload.result) {
      return payload.result as TherapySession;
    }

    if (!response.ok || payload?.status === "failed") {
      throw new Error(payload?.message || payload?.error || "processing_failed");
    }
  }

  throw new Error("העיבוד נמשך יותר מדי זמן. אם סימנת שמירת אודיו, הקובץ נשמר ב-Google Drive ואפשר לנסות שוב מאוחר יותר.");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askSessionQuestion(payload: {
  question: string;
  session: TherapySession;
  previousSessions?: TherapySession[];
}): Promise<string> {
  const response = await fetch("/api/chat-session", {
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
  const response = await fetch("/api/progress-summary", {
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
