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
    response = await fetch("/api/process-session", {
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

  return (await response.json()) as TherapySession;
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
