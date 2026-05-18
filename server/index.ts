import express from "express";
import "dotenv/config";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildObjectName,
  deleteObject,
  downloadJson,
  downloadObject,
  isCloudStorageConfigured,
  uploadJson,
  uploadObject
} from "./cloudStorage";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }
});
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const DIRECT_TRANSCRIBE_LIMIT_BYTES = Number(process.env.DIRECT_TRANSCRIBE_LIMIT_BYTES || 8 * 1024 * 1024);
const PROCESSING_JOB_TTL_MS = Number(process.env.PROCESSING_JOB_TTL_MS || 2 * 60 * 60 * 1000);
const PROCESSING_MODE = normalizeProcessingMode(process.env.PROCESSING_MODE);

type ProcessingJob = {
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  message?: string;
  stage?: string;
  session?: any;
  audioObjectName?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
};

const processingJobs = new Map<string, ProcessingJob>();
const activeCloudJobs = new Set<string>();
const uploadJobs = new Map<string, {
  session: any;
  filePath: string;
  originalname: string;
  mimetype: string;
  size: number;
  receivedBytes: number;
  createdAt: string;
}>();

app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openai: Boolean(openai),
    ffmpeg: Boolean(ffmpegPath),
    cloudStorage: isCloudStorageConfigured(),
    processingMode: PROCESSING_MODE
  });
});

app.get("/api/client-config", (_req, res) => {
  res.json({
    googleClientId: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ""
  });
});

app.get("/api/debug-openai", async (_req, res) => {
  if (!openai) {
    res.status(500).json({ ok: false, step: "config", message: "OPENAI_API_KEY לא נטען בשרת" });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "ענה במילה אחת בעברית." },
        { role: "user", content: "בדיקה" }
      ]
    });

    res.json({
      ok: true,
      chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      sample: completion.choices[0]?.message?.content || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      step: "chat",
      chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      message: getSafeErrorMessage(error)
    });
  }
});

app.post("/api/process-session", upload.single("audio"), async (req, res) => {
  const now = new Date().toISOString();
  const session = parseSession(req.body?.session);
  const fallback = buildDemoSession(session, now);

  if (!req.file) {
    res.status(400).json({
      error: "missing_audio",
      message: "לא צורף קובץ אודיו לעיבוד. יש להקליט ולעצור את ההקלטה לפני הפקת דו״ח, או להעלות קובץ אודיו."
    });
    return;
  }

  if (!openai) {
    res.status(500).json({
      error: "missing_openai_key",
      message: "OPENAI_API_KEY לא נטען בשרת. יש לבדוק את משתני הסביבה ב-Render."
    });
    return;
  }

  try {
    const transcript = await transcribeAudio(req.file);
    let aiReport = normalizeAiReport(await createTherapyReport(session, transcript), transcript);
    if (!reportLooksHebrew(aiReport)) {
      aiReport = normalizeAiReport(await rewriteReportInHebrew(session, aiReport), transcript);
    }

    res.json({
      ...session,
      processingStatus: "completed",
      audioStored: false,
      report: {
        title: "דו״ח סיכום פגישה טיפולית",
        meetingTopic: aiReport.meetingTopic || "",
        sessionNarrative: aiReport.sessionNarrative || "",
        therapeuticInsights: aiReport.therapeuticInsights || "",
        followUpPoints: Array.isArray(aiReport.followUpPoints) ? aiReport.followUpPoints : [],
        administrativeNotes: aiReport.administrativeNotes || "",
        crmSummary: aiReport.crmSummary || ""
      },
      internalSessionMemory: aiReport.internalSessionMemory || fallback.internalSessionMemory,
      updatedAt: now
    });
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("processing_failed", message);
    res.status(500).json({ error: "processing_failed", message });
  }
});

app.post("/api/process-session-job", upload.single("audio"), async (req, res) => {
  const session = parseSession(req.body?.session);

  if (!req.file) {
    res.status(400).json({
      error: "missing_audio",
      message: "לא צורף קובץ אודיו לעיבוד. יש להקליט ולעצור את ההקלטה לפני הפקת דו״ח, או להעלות קובץ אודיו."
    });
    return;
  }

  if (!openai) {
    res.status(500).json({
      error: "missing_openai_key",
      message: "OPENAI_API_KEY לא נטען בשרת. יש לבדוק את משתני הסביבה ב-Render."
    });
    return;
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const file = cloneUploadedFile(req.file);
  const job: ProcessingJob = { status: "queued", createdAt: now, updatedAt: now, stage: "audio_received" };
  processingJobs.set(jobId, job);
  res.status(202).json({ jobId, status: "queued" });

  if (isCloudStorageConfigured()) {
    void runCloudBackedJobFromFile(jobId, session, file);
  } else {
    void runProcessingJob(jobId, session, file);
  }
});

app.post("/api/process-session-upload", async (req, res) => {
  const session = parseSession(req.body?.session);
  const originalname = String(req.body?.fileName || `recording-${session.sessionId || crypto.randomUUID()}.m4a`);
  const mimetype = String(req.body?.mimeType || "application/octet-stream");
  const size = Number(req.body?.size || 0);

  if (!openai) {
    res.status(500).json({
      error: "missing_openai_key",
      message: "OPENAI_API_KEY לא נטען בשרת. יש לבדוק את משתני הסביבה ב-Render."
    });
    return;
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const uploadDir = await ensureUploadJobDir(jobId);
  const filePath = path.join(uploadDir, "audio-upload");
  await writeFile(filePath, Buffer.alloc(0));
  processingJobs.set(jobId, { status: "queued", createdAt: now, updatedAt: now });
  uploadJobs.set(jobId, {
    session,
    filePath,
    originalname,
    mimetype,
    size,
    receivedBytes: 0,
    createdAt: now
  });

  res.status(202).json({ jobId, status: "uploading" });
});

app.post(
  "/api/process-session-upload/:jobId/chunk",
  express.raw({ type: "*/*", limit: "6mb" }),
  async (req, res) => {
    const uploadJob = uploadJobs.get(req.params.jobId);
    if (!uploadJob) {
      res.status(404).json({ error: "upload_not_found", message: "העלאת האודיו לא נמצאה. נסה להתחיל מחדש." });
      return;
    }

    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!chunk.length) {
      res.status(400).json({ error: "empty_chunk", message: "התקבל מקטע אודיו ריק." });
      return;
    }

    await appendFile(uploadJob.filePath, chunk);
    uploadJob.receivedBytes += chunk.length;
    res.json({ ok: true, receivedBytes: uploadJob.receivedBytes, expectedBytes: uploadJob.size });
  }
);

app.post("/api/process-session-upload/:jobId/complete", async (req, res) => {
  const uploadJob = uploadJobs.get(req.params.jobId);
  if (!uploadJob) {
    res.status(404).json({ error: "upload_not_found", message: "העלאת האודיו לא נמצאה. נסה להתחיל מחדש." });
    return;
  }

  if (uploadJob.size && uploadJob.receivedBytes < uploadJob.size) {
    res.status(400).json({
      error: "incomplete_upload",
      message: `העלאת האודיו לא הושלמה. התקבלו ${uploadJob.receivedBytes} מתוך ${uploadJob.size} בתים.`
    });
    return;
  }

  res.status(202).json({ jobId: req.params.jobId, status: "queued" });
  if (isCloudStorageConfigured()) {
    void runCloudBackedUploadedProcessingJob(req.params.jobId);
  } else {
    void runUploadedProcessingJob(req.params.jobId);
  }
});

app.get("/api/process-session-job/:jobId", async (req, res) => {
  const job = (await getProcessingJob(req.params.jobId)) || null;
  if (!job) {
    res.status(404).json({ error: "job_not_found", message: "עבודת העיבוד לא נמצאה. ייתכן שהשרת הופעל מחדש או שהעיבוד ישן מדי." });
    return;
  }

  if (shouldRunCloudJobInline() && job.audioObjectName && (job.status === "queued" || job.status === "processing")) {
    void runCloudProcessingJob(req.params.jobId);
  }

  if (job.status === "completed") {
    res.json({ status: job.status, result: job.result });
    return;
  }

  if (job.status === "failed") {
    res.status(500).json({ status: job.status, error: "processing_failed", message: job.message || "עיבוד האודיו נכשל." });
    return;
  }

  res.json({ status: job.status, stage: job.stage, message: job.message });
});

app.post("/api/internal/process-job", async (req, res) => {
  if (!authorizeWorkerRequest(req)) {
    res.status(401).json({ error: "unauthorized", message: "worker token is missing or invalid" });
    return;
  }

  if (!isCloudStorageConfigured()) {
    res.status(500).json({ error: "cloud_storage_not_configured", message: "Cloud Storage is required for worker processing." });
    return;
  }

  if (!openai) {
    res.status(500).json({ error: "missing_openai_key", message: "OPENAI_API_KEY is required for worker processing." });
    return;
  }

  const jobId = String(req.body?.jobId || req.query?.jobId || "").trim();
  if (!jobId) {
    res.status(400).json({ error: "missing_job_id", message: "jobId is required." });
    return;
  }

  const job = await getProcessingJob(jobId);
  if (!job) {
    res.status(404).json({ error: "job_not_found", message: "Processing job was not found." });
    return;
  }

  if (job.status === "completed" || job.status === "failed") {
    res.json({ jobId, status: job.status, stage: job.stage, message: job.message });
    return;
  }

  await runCloudProcessingJob(jobId);
  const updated = await getProcessingJob(jobId);
  res.json({
    jobId,
    status: updated?.status || "unknown",
    stage: updated?.stage,
    message: updated?.message
  });
});

app.post("/api/chat-session", async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const session = req.body?.session;

  if (!question || !session) {
    res.status(400).json({ error: "missing_question_or_session" });
    return;
  }

  if (!openai) {
    res.json({
      answer:
        "במצב הדגמה ניתן לענות רק על בסיס הדוח השמור. לאחר הוספת OPENAI_API_KEY, התשובה תתבסס על הדוח, הזיכרון הפנימי ופגישות קודמות אם נבחרו."
    });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "אתה מסייע למטפל לענות בעברית על שאלות לגבי פגישה טיפולית שכבר סוכמה. אל תמציא מידע. אם אין מספיק מידע, ענה בדיוק: אין מספיק מידע בדוח הפגישה כדי לקבוע זאת. הבחֵן בין מה שנאמר בפגישה לבין פרשנות טיפולית, והימנע מאבחנות נחרצות."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              question,
              sessionReport: session.report,
              internalSessionMemory: session.internalSessionMemory,
              metadata: {
                patientDisplayName: session.patientDisplayName,
                therapistName: session.therapistName,
                sessionDate: session.sessionDate,
                participants: session.participants
              },
              previousSessions: req.body?.previousSessions || []
            },
            null,
            2
          )
        }
      ]
    });

    res.json({ answer: completion.choices[0]?.message?.content || "אין מספיק מידע בדוח הפגישה כדי לקבוע זאת." });
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("chat_failed", message);
    res.status(500).json({ error: "chat_failed", message });
  }
});

app.post("/api/progress-summary", async (req, res) => {
  const sessions = Array.isArray(req.body?.sessions) ? req.body.sessions : [];
  if (!sessions.length) {
    res.status(400).json({ error: "missing_sessions", message: "אין פגישות בטווח שנבחר." });
    return;
  }

  if (!openai) {
    res.json({ summary: "אין מספיק מידע בדוחות הפגישה כדי להפיק סיכום התקדמות." });
    return;
  }

  try {
    const completion = await withOpenAiRetry(
      () =>
        openai.chat.completions.create({
          model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "אתה מסייע למטפל להפיק סיכום התקדמות תקופתי בעברית על בסיס דוחות פגישות בלבד. אל תמציא מידע. הבחן בין מידע שעלה בפגישות לבין פרשנות טיפולית. כתוב מקצועי, זהיר ולא אבחוני מדי."
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  patientDisplayName: req.body?.patientDisplayName,
                  dateFrom: req.body?.dateFrom,
                  dateTo: req.body?.dateTo,
                  requestedStructure: [
                    "תיאור תמציתי של התהליך",
                    "נושאים חוזרים",
                    "שינויים שנצפו",
                    "מוקדי קושי",
                    "מוקדי התקדמות",
                    "נקודות להמשך טיפול",
                    "סיכום CRM תקופתי קצר"
                  ],
                  sessions: sessions.map((session: any) => ({
                    sessionDate: session.sessionDate,
                    report: session.report,
                    internalSessionMemory: session.internalSessionMemory
                  }))
                },
                null,
                2
              )
            }
          ]
        }),
      "סיכום התקדמות"
    );

    res.json({ summary: completion.choices[0]?.message?.content || "אין מספיק מידע בדוחות הפגישה כדי להפיק סיכום התקדמות." });
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("progress_summary_failed", message);
    res.status(500).json({ error: "progress_summary_failed", message });
  }
});

function parseSession(raw: unknown) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallbackSession();
    }
  }

  if (raw && typeof raw === "object") return raw as Record<string, any>;
  return fallbackSession();
}

function getSafeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error) {
    const maybe = error as Record<string, any>;
    return String(maybe.message || maybe.error?.message || maybe.status || "unknown_error");
  }
  return String(error || "unknown_error");
}

function fallbackSession() {
  return {
    sessionId: crypto.randomUUID(),
    patientDisplayName: "מטופל/ת",
    therapistName: "מטפל/ת",
    sessionDate: new Date().toISOString().slice(0, 10),
    sessionStartTime: "09:00",
    report: {}
  };
}

function buildDemoSession(session: any, now: string) {
  return {
    ...session,
    processingStatus: "completed",
    audioStored: false,
    report: {
      title: "דו״ח סיכום פגישה טיפולית",
      meetingTopic: session.report?.meetingTopic || "נושא המפגש",
      sessionNarrative:
        "הפגישה עובדה במצב הדגמה. לאחר הוספת OPENAI_API_KEY וחיבור אודיו אמיתי, חלק זה יתבסס על תמלול זמני ויתאר רק את התכנים שעלו בפגישה.",
      therapeuticInsights:
        "במצב הדגמה מוצגת המשגה כללית בלבד. בחיבור המלא, חלק זה יפריד בין עובדות שעלו בפגישה לבין השערות טיפוליות זהירות והתערבויות אפשריות.",
      followUpPoints: ["להשלים בדיקה עם קובץ אודיו אמיתי.", "לוודא שהדוח נערך ונשמר לפני ייצוא או שיתוף."],
      administrativeNotes: session.report?.administrativeNotes || "אין הערות אדמיניסטרטיביות מיוחדות.",
      crmSummary:
        `התקיימה פגישה עם ${session.patientDisplayName || "המטופל/ת"} בתאריך ${session.sessionDate || ""}.\n` +
        "בפגישה תועדו מוקדי עבודה טיפוליים לצורך המשך מעקב.\n" +
        "הדוח הנוכחי נוצר במצב הדגמה לפני חיבור תמלול AI מלא.\n" +
        "להמשך מומלץ לעדכן את הדוח לאחר עיבוד אודיו אמיתי."
    },
    internalSessionMemory: {
      factsFromSession: ["מצב הדגמה: טרם נשמר תמלול מלא."],
      aiInterpretations: ["יש להוסיף OPENAI_API_KEY כדי להפיק פרשנות אמיתית בצד השרת."],
      interventions: [],
      riskOrUncertaintyNotes: ["אין להסיק מסקנות קליניות מדוח הדגמה."],
      openQuestionsForNextSession: []
    },
    updatedAt: now
  };
}

async function processSessionAudio(session: any, file: Express.Multer.File) {
  const now = new Date().toISOString();
  const fallback = buildDemoSession(session, now);
  const transcript = await transcribeAudio(file);
  if (!hasMeaningfulTranscript(transcript)) {
    throw new Error("התמלול מהאודיו יצא ריק. ייתכן שהקובץ הוקלט בעוצמה נמוכה, שהמיקרופון נחסם, או שמודל התמלול לא הצליח לפענח את ההקלטה. מומלץ לבדוק שהאודיו נשמע ברור ולנסות שוב.");
  }
  let aiReport = normalizeAiReport(await createTherapyReport(session, transcript), transcript);
  if (!reportLooksHebrew(aiReport)) {
    aiReport = normalizeAiReport(await rewriteReportInHebrew(session, aiReport), transcript);
  }
  if (!reportLooksDetailed(aiReport)) {
    aiReport = normalizeAiReport(await enrichTherapyReport(session, transcript, aiReport), transcript);
    if (!reportLooksHebrew(aiReport)) {
      aiReport = normalizeAiReport(await rewriteReportInHebrew(session, aiReport), transcript);
    }
  }

  return {
    ...session,
    processingStatus: "completed",
    audioStored: Boolean(session.audioStored),
    audioFileName: session.audioFileName,
    audioMimeType: session.audioMimeType,
    report: {
      title: "דו״ח סיכום פגישה טיפולית",
      meetingTopic: aiReport.meetingTopic || "",
      sessionNarrative: aiReport.sessionNarrative || "",
      therapeuticInsights: aiReport.therapeuticInsights || "",
      followUpPoints: Array.isArray(aiReport.followUpPoints) ? aiReport.followUpPoints : [],
      administrativeNotes: aiReport.administrativeNotes || "",
      crmSummary: aiReport.crmSummary || ""
    },
    internalSessionMemory: aiReport.internalSessionMemory || fallback.internalSessionMemory,
    updatedAt: now
  };
}

function normalizeProcessingMode(value: string | undefined) {
  if (value === "inline" || value === "worker" || value === "hybrid") return value;
  return "hybrid";
}

function shouldRunCloudJobInline() {
  return isCloudStorageConfigured() && PROCESSING_MODE !== "worker";
}

function authorizeWorkerRequest(req: express.Request) {
  const token = process.env.PROCESSING_WORKER_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  const headerToken = req.header("x-worker-token") || "";
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  return headerToken === token || bearer === token;
}

async function runCloudBackedJobFromFile(jobId: string, session: any, file: Express.Multer.File) {
  try {
    updateProcessingJob(jobId, { status: "processing", stage: "saving_audio_to_cloud" });
    const audioObjectName = buildAudioObjectName(jobId, session, file.originalname);
    await uploadObject(audioObjectName, file.buffer, file.mimetype || "application/octet-stream");
    const now = new Date().toISOString();
    const current = processingJobs.get(jobId) || { status: "queued" as const, createdAt: now, updatedAt: now };
    const job: ProcessingJob = {
      ...current,
      status: "queued" as const,
      stage: "queued_for_background_processing",
      session,
      audioObjectName,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    };
    processingJobs.set(jobId, job);
    await persistProcessingJob(jobId, job);
    if (shouldRunCloudJobInline()) {
      void runCloudProcessingJob(jobId);
    }
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("cloud_job_prepare_failed", jobId, message);
    updateProcessingJob(jobId, { status: "failed", stage: "cloud_upload_failed", message });
  }
}

async function runCloudBackedUploadedProcessingJob(jobId: string) {
  const uploadJob = uploadJobs.get(jobId);
  if (!uploadJob) {
    updateProcessingJob(jobId, { status: "failed", stage: "upload_missing", message: "העלאת האודיו לא נמצאה." });
    return;
  }

  try {
    updateProcessingJob(jobId, { status: "processing", stage: "saving_audio_to_cloud" });
    const buffer = await readFile(uploadJob.filePath);
    const audioObjectName = buildAudioObjectName(jobId, uploadJob.session, uploadJob.originalname);
    await uploadObject(audioObjectName, buffer, uploadJob.mimetype || "application/octet-stream");
    const now = new Date().toISOString();
    const current = processingJobs.get(jobId) || { status: "queued" as const, createdAt: now, updatedAt: now };
    const job: ProcessingJob = {
      ...current,
      status: "queued" as const,
      stage: "queued_for_background_processing",
      session: uploadJob.session,
      audioObjectName,
      originalname: uploadJob.originalname,
      mimetype: uploadJob.mimetype,
      size: buffer.length
    };
    processingJobs.set(jobId, job);
    await persistProcessingJob(jobId, job);
    uploadJobs.delete(jobId);
    await cleanupUploadJobDir(jobId);
    if (shouldRunCloudJobInline()) {
      void runCloudProcessingJob(jobId);
    }
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("cloud_uploaded_job_prepare_failed", jobId, message);
    updateProcessingJob(jobId, { status: "failed", stage: "cloud_upload_failed", message });
  }
}

async function runCloudProcessingJob(jobId: string) {
  if (activeCloudJobs.has(jobId)) return;
  activeCloudJobs.add(jobId);

  try {
    const job = await getProcessingJob(jobId);
    if (!job?.audioObjectName || !job.session) {
      updateProcessingJob(jobId, { status: "failed", stage: "missing_cloud_job_data", message: "חסרים פרטי עיבוד בענן." });
      return;
    }
    if (job.status === "completed" || job.status === "failed") return;

    updateProcessingJob(jobId, { status: "processing", stage: "downloading_audio_from_cloud" });
    const buffer = await downloadObject(job.audioObjectName);
    const file = buildCloudFile(job, buffer);
    updateProcessingJob(jobId, { status: "processing", stage: "transcribing_and_summarizing" });
    const result = await processSessionAudio(job.session, file);
    updateProcessingJob(jobId, { status: "completed", stage: "completed", result });

    if (process.env.DELETE_CLOUD_AUDIO_AFTER_SUCCESS !== "false") {
      await deleteObject(job.audioObjectName).catch((error) => {
        console.warn("cloud_audio_cleanup_failed", jobId, getSafeErrorMessage(error));
      });
    }
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("cloud_processing_job_failed", jobId, message);
    updateProcessingJob(jobId, { status: "failed", stage: "failed", message });
  } finally {
    activeCloudJobs.delete(jobId);
    setTimeout(() => processingJobs.delete(jobId), PROCESSING_JOB_TTL_MS).unref?.();
  }
}

async function runProcessingJob(jobId: string, session: any, file: Express.Multer.File) {
  updateProcessingJob(jobId, { status: "processing" });
  try {
    const result = await processSessionAudio(session, file);
    updateProcessingJob(jobId, { status: "completed", result });
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("processing_job_failed", jobId, message);
    updateProcessingJob(jobId, { status: "failed", message });
  } finally {
    setTimeout(() => processingJobs.delete(jobId), PROCESSING_JOB_TTL_MS).unref?.();
  }
}

async function runUploadedProcessingJob(jobId: string) {
  const uploadJob = uploadJobs.get(jobId);
  if (!uploadJob) {
    updateProcessingJob(jobId, { status: "failed", message: "העלאת האודיו לא נמצאה." });
    return;
  }

  updateProcessingJob(jobId, { status: "processing" });
  try {
    const buffer = await readFile(uploadJob.filePath);
    const file = buildUploadedFile(uploadJob, buffer);
    const result = await processSessionAudio(uploadJob.session, file);
    updateProcessingJob(jobId, { status: "completed", result });
  } catch (error) {
    const message = getSafeErrorMessage(error);
    console.error("uploaded_processing_job_failed", jobId, message);
    updateProcessingJob(jobId, { status: "failed", message });
  } finally {
    uploadJobs.delete(jobId);
    await cleanupUploadJobDir(jobId);
    setTimeout(() => processingJobs.delete(jobId), PROCESSING_JOB_TTL_MS).unref?.();
  }
}

function updateProcessingJob(jobId: string, patch: Partial<ProcessingJob>) {
  const current = processingJobs.get(jobId);
  if (!current) return;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  processingJobs.set(jobId, next);
  void persistProcessingJob(jobId, next);
}

async function getProcessingJob(jobId: string) {
  const inMemory = processingJobs.get(jobId);
  if (inMemory) return inMemory;
  if (!isCloudStorageConfigured()) return null;
  const persisted = await downloadJson<ProcessingJob>(jobObjectName(jobId));
  if (persisted) processingJobs.set(jobId, persisted);
  return persisted;
}

async function persistProcessingJob(jobId: string, job: ProcessingJob) {
  if (!isCloudStorageConfigured()) return;
  try {
    await uploadJson(jobObjectName(jobId), job);
  } catch (error) {
    console.warn("persist_processing_job_failed", jobId, getSafeErrorMessage(error));
  }
}

function jobObjectName(jobId: string) {
  return buildObjectName("jobs", `${jobId}.json`);
}

function buildAudioObjectName(jobId: string, session: any, fileName: string) {
  const date = String(session?.sessionDate || new Date().toISOString().slice(0, 10));
  const patient = String(session?.patientDisplayName || "patient").slice(0, 60);
  return buildObjectName("audio", date, `${patient}-${jobId}-${fileName || "recording"}`);
}

function cloneUploadedFile(file: Express.Multer.File): Express.Multer.File {
  return {
    ...file,
    buffer: Buffer.from(file.buffer)
  };
}

function buildUploadedFile(uploadJob: NonNullable<ReturnType<typeof uploadJobs.get>>, buffer: Buffer): Express.Multer.File {
  return {
    fieldname: "audio",
    originalname: uploadJob.originalname,
    encoding: "7bit",
    mimetype: uploadJob.mimetype,
    size: buffer.length,
    destination: "",
    filename: uploadJob.originalname,
    path: uploadJob.filePath,
    buffer,
    stream: undefined as any
  };
}

function buildCloudFile(job: ProcessingJob, buffer: Buffer): Express.Multer.File {
  return {
    fieldname: "audio",
    originalname: job.originalname || "recording.webm",
    encoding: "7bit",
    mimetype: job.mimetype || "application/octet-stream",
    size: buffer.length,
    destination: "",
    filename: job.originalname || "recording.webm",
    path: "",
    buffer,
    stream: undefined as any
  };
}

async function ensureUploadJobDir(jobId: string) {
  const root = path.join(process.cwd(), "server-tmp", "uploads");
  const directory = path.join(root, jobId);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function cleanupUploadJobDir(jobId: string) {
  const directory = path.join(process.cwd(), "server-tmp", "uploads", jobId);
  if (directory.startsWith(path.join(process.cwd(), "server-tmp", "uploads"))) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function transcribeAudio(file: Express.Multer.File) {
  if (!openai) throw new Error("missing_openai_client");

  if (file.size <= DIRECT_TRANSCRIBE_LIMIT_BYTES && isDirectTranscriptionMime(file.mimetype)) {
    try {
      const transcription = await transcribeBufferWithFallback(
        file.buffer,
        ensureAudioFileName(file.originalname, file.mimetype),
        file.mimetype,
        "תמלול קובץ מלא"
      );
      return typeof transcription === "string" ? transcription : String(transcription);
    } catch (error) {
      const message = getSafeErrorMessage(error);
      if (!isUnsupportedAudioError(message) && !isDirectAudioTooLargeError(message)) throw error;
      console.warn("direct_transcription_failed_trying_ffmpeg", message);
    }
  }

  const chunks = await createAudioChunks(file);
  const transcripts: string[] = [];

  try {
    for (const [index, chunk] of chunks.entries()) {
      const buffer = await readFile(chunk);
      const transcription = await transcribeBufferWithFallback(buffer, path.basename(chunk), "audio/mpeg", `תמלול מקטע ${index + 1}`);

      const text = typeof transcription === "string" ? transcription : String(transcription);
      if (text.trim()) {
        transcripts.push(`[מקטע ${index + 1}]\n${text.trim()}`);
      } else {
        console.warn("empty_transcription_chunk", index + 1, path.basename(chunk), buffer.length);
      }
    }
  } finally {
    await cleanupChunks(chunks);
  }

  const transcript = transcripts.join("\n\n");
  if (!hasMeaningfulTranscript(transcript)) {
    throw new Error("התמלול מהאודיו יצא ריק בכל המקטעים. ייתכן שההקלטה שקטה מדי או שהפורמט לא פוענח נכון.");
  }
  return transcript;
}

async function transcribeBuffer(buffer: Buffer, fileName: string, mimeType: string, label: string) {
  if (!openai) throw new Error("missing_openai_client");
  const openAiFile = await toFile(buffer, fileName, { type: mimeType });
  return withOpenAiRetry(
    () =>
      openai.audio.transcriptions.create({
        file: openAiFile,
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
        response_format: "text",
        language: "he",
        prompt: "השיחה בעברית. תמלל את כל הדיבור הנשמע, גם אם האיכות נמוכה או הדיבור שקט."
      }),
    label
  );
}

async function transcribeBufferWithFallback(buffer: Buffer, fileName: string, mimeType: string, label: string) {
  const primary = await transcribeBuffer(buffer, fileName, mimeType, label);
  const primaryText = typeof primary === "string" ? primary : String(primary);
  if (primaryText.trim()) return primaryText;

  const fallbackModel = process.env.OPENAI_FALLBACK_TRANSCRIBE_MODEL || "whisper-1";
  if (fallbackModel === (process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe")) return primaryText;

  console.warn("empty_transcription_trying_fallback", label, fallbackModel);
  if (!openai) throw new Error("missing_openai_client");
  const openAiFile = await toFile(buffer, fileName, { type: mimeType });
  return withOpenAiRetry(
    () =>
      openai.audio.transcriptions.create({
        file: openAiFile,
        model: fallbackModel,
        response_format: "text",
        language: "he",
        prompt: "השיחה בעברית. תמלל את כל הדיבור הנשמע, גם אם האיכות נמוכה או הדיבור שקט."
      }),
    `${label} - גיבוי`
  );
}

async function createAudioChunks(file: Express.Multer.File) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg לא זמין ולכן אי אפשר לחלק קובץ אודיו גדול למקטעים.");
  }

  const root = path.join(process.cwd(), "server-tmp");
  await mkdir(root, { recursive: true });
  const jobDir = path.join(root, `${Date.now()}-${crypto.randomUUID()}`);
  await mkdir(jobDir, { recursive: true });

  const extension = extensionFromMime(file.mimetype) || path.extname(file.originalname || "") || ".webm";
  const inputPath = path.join(jobDir, `input${extension}`);
  const outputPattern = path.join(jobDir, "chunk-%03d.mp3");
  await writeFile(inputPath, file.buffer);

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-af",
    "dynaudnorm=f=150:g=15,volume=1.8",
    "-b:a",
    "48k",
    "-f",
    "segment",
    "-segment_time",
    process.env.AUDIO_CHUNK_SECONDS || "240",
    "-reset_timestamps",
    "1",
    outputPattern
  ]);

  const files = (await readdir(jobDir))
    .filter((name) => name.startsWith("chunk-") && name.endsWith(".mp3"))
    .sort()
    .map((name) => path.join(jobDir, name));

  if (!files.length) {
    throw new Error("לא הצלחנו לחלק את קובץ האודיו למקטעים. ייתכן שהפורמט אינו נתמך או שהקובץ פגום.");
  }

  return files;
}

async function cleanupChunks(chunks: string[]) {
  const directories = new Set(chunks.map((chunk) => path.dirname(chunk)));
  for (const directory of directories) {
    if (directory.startsWith(path.join(process.cwd(), "server-tmp"))) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.slice(-1200) || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

function extensionFromMime(mimeType: string) {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return ".m4a";
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("webm")) return ".webm";
  return "";
}

function ensureAudioFileName(fileName: string | undefined, mimeType: string) {
  const extension = extensionFromMime(mimeType) || ".webm";
  const cleanName = fileName?.trim();
  if (!cleanName) return `recording${extension}`;
  if (path.extname(cleanName)) return cleanName;
  return `${cleanName}${extension}`;
}

function isDirectTranscriptionMime(mimeType: string) {
  return Boolean(extensionFromMime(mimeType));
}

function isUnsupportedAudioError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("corrupted") || lower.includes("unsupported") || lower.includes("invalid file format");
}

function isDirectAudioTooLargeError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("tokens") && lower.includes("audio") && lower.includes("too large");
}

function hasMeaningfulTranscript(transcript: string) {
  const withoutSegmentLabels = transcript
    .replace(/\[מקטע \d+\]/g, "")
    .replace(/\[׳׳§׳˜׳¢ \d+\]/g, "")
    .trim();
  const hebrewLetters = withoutSegmentLabels.match(/[\u0590-\u05ff]/g)?.length || 0;
  const latinLetters = withoutSegmentLabels.match(/[a-zA-Z]/g)?.length || 0;
  return withoutSegmentLabels.length > 80 && hebrewLetters + latinLetters > 30;
}

async function createTherapyReport(session: any, transcript: string) {
  if (!openai) throw new Error("missing_openai_client");

  const completion = await withOpenAiRetry(
    () =>
      openai.chat.completions.create({
        model: process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              [
                "אתה מסייע למטפל לנסח דו״ח סיכום פגישה טיפולית בעברית בלבד.",
                "החזר JSON תקין בלבד, ללא Markdown וללא טקסט מסביב. שמות השדות חייבים להישאר באנגלית בדיוק כפי שמופיעים בסכמה.",
                "המטרה היא דוח מקצועי-טיפולי עשיר, ספציפי וקליני, בסגנון תיעוד של מטפל מנוסה, לא סיכום כללי ודל.",
                "כתוב בגוף שלישי, בעברית טבעית, רגישה וזהירה. הימנע מאבחנות נחרצות אם הן לא נאמרו במפורש.",
                "שמות ודמויות: אם בתמלול מוזכרים שמות פרטיים, ראשי תיבות או כינויים, השתמש בהם בדוח כפי שנאמרו. אל תחליף אותם במילים כלליות כמו 'הילדים', 'הבעל' או 'בן משפחה' כאשר יש שם או ראשי תיבות. אם ברור שמדובר בבעל/ילד/אב/אם, אפשר לכתוב למשל 'בעלה ע׳' או 'בנה ה׳'. אל תמציא שמות שלא נאמרו.",
                "בחלק sessionNarrative כתוב את מהלך המפגש: מה המטופל/ת שיתף/ה, אילו אירועים, רגשות, דפוסים, יחסים, קונפליקטים, פחדים וזיכרונות עלו. השתמש בפרטים ממשיים מתוך התמלול, כולל שמות, תפקידים, קשרים משפחתיים, אירועים ותאריכים אם נאמרו. אל תכניס כאן פרשנות קלינית עמוקה או התערבויות של המטפל.",
                "בחלק therapeuticInsights כתוב את ההמשגה הטיפולית ואת ההתערבויות: מה המטפל שיקף, בדק, המשיג, אתגר, הציע או הדגיש; אילו קשרים טיפוליים ניתן לשער בין עבר להווה; אילו דפוסים רגשיים/זוגיים/משפחתיים עלו. נסח בזהירות: 'נראה כי', 'ייתכן', 'ניתן לשער', 'עלה קישור בין'.",
                "הדוח צריך להיות מפורט: sessionNarrative לפחות 2-4 פסקאות עשירות כאשר יש מספיק חומר; therapeuticInsights לפחות 1-3 פסקאות. אל תסתפק בניסוחים כלליים כמו 'קשיים משפחתיים ומקצועיים' אם בתמלול יש פרטים.",
                "followUpPoints צריכים להיות 4-7 נקודות מעקב ממוקדות, טיפוליות וקונקרטיות.",
                "administrativeNotes יכלול רק עניינים מנהליים שנאמרו: תשלום, התחייבות, ביטוח, תיאום פגישה, מספר מפגשים, מסמכים וכדומה. אם לא נאמר, השאר ריק או קצר.",
                "crmSummary יהיה 3-4 שורות בלבד, יבש ומקצועי, ללא פירוט מזהה עודף.",
                "אל תמציא פרטים. אם דבר לא ברור, כתוב בזהירות שהוא עלה באופן לא ודאי או השמט אותו."
              ].join(" ")
          },
          {
            role: "user",
            content: `מטא דאטה:
תאריך המפגש: ${session.sessionDate}
שעת המפגש: ${session.sessionStartTime}
שם המטופל/ת: ${session.patientDisplayName}
שם המטפל/ת: ${session.therapistName}
נוכחים: ${session.participants || ""}
סוג פגישה: ${session.sessionType || ""}

תמלול זמני:
${transcript}

החזר JSON במבנה הזה בדיוק. שמות השדות חייבים להישאר באנגלית.
הנחיות איכות מחייבות:
- meetingTopic: משפט קצר, ספציפי וטיפולי, לא כותרת כללית.
- sessionNarrative: תיאור עשיר של מה שנאמר בפגישה, כולל שמות/ראשי תיבות שהוזכרו, אירועים, רגשות, עומסים, יחסים ודוגמאות.
- therapeuticInsights: המשגה והתערבויות טיפוליות, כולל שיקופים, שאלות, דימויים, אתגורים והבחנות של המטפל אם הופיעו בתמלול.
- followUpPoints: נקודות מעקב טיפוליות קונקרטיות.
- administrativeNotes: רק נושאים מנהליים שנאמרו.
- internalSessionMemory: שמור מידע מפורט יותר לשאלות המשך, תוך הפרדה בין עובדות לפרשנות.
{
  "meetingTopic": "",
  "sessionNarrative": "",
  "therapeuticInsights": "",
  "followUpPoints": [],
  "administrativeNotes": "",
  "crmSummary": "",
  "internalSessionMemory": {
    "factsFromSession": [],
    "aiInterpretations": [],
    "interventions": [],
    "riskOrUncertaintyNotes": [],
    "openQuestionsForNextSession": []
  }
}`
          }
        ]
      }),
    "יצירת דוח"
  );

  return JSON.parse(completion.choices[0]?.message?.content || "{}");
}

async function rewriteReportInHebrew(session: any, report: any) {
  if (!openai) throw new Error("missing_openai_client");

  const completion = await withOpenAiRetry(
    () =>
      openai.chat.completions.create({
        model: process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "תקן דוח פגישה טיפולית כך שכל ערכי הטקסט יהיו בעברית בלבד, מקצועיים וטיפוליים יותר. שמות השדות חייבים להישאר באנגלית בדיוק. אל תמציא פרטים ואל תשנה עובדות. אם יש שמות פרטיים, ראשי תיבות או כינויים, השאר אותם בדוח כפי שנמסרו ואל תחליף אותם בתיאורים כלליים. שמור על הפרדה בין מה שנאמר בפגישה לבין פרשנות והתערבויות טיפוליות. החזר JSON תקין בלבד."
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                metadata: {
                  sessionDate: session.sessionDate,
                  patientDisplayName: session.patientDisplayName,
                  therapistName: session.therapistName
                },
                report
              },
              null,
              2
            )
          }
        ]
      }),
    "תיקון שפת הדוח לעברית"
  );

  return JSON.parse(completion.choices[0]?.message?.content || "{}");
}

async function enrichTherapyReport(session: any, transcript: string, report: any) {
  if (!openai) throw new Error("missing_openai_client");

  const completion = await withOpenAiRetry(
    () =>
      openai.chat.completions.create({
        model: process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini",
        temperature: 0.15,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "שפר דוח סיכום פגישה טיפולית בעברית כך שיהיה מקצועי, טיפולי, עשיר וספציפי יותר, בדומה לתיעוד קליני של מטפל מנוסה. החזר JSON תקין בלבד עם אותם שמות שדות באנגלית. אל תמציא פרטים. השתמש רק בתמלול ובדוח הקיים. שמור שמות פרטיים, ראשי תיבות וכינויים כפי שנאמרו. הרחב את מהלך המפגש בפרטים ממשיים ואת התובנות בהתערבויות/המשגות טיפוליות. אל תכתוב סיכום כללי ודל."
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                metadata: {
                  sessionDate: session.sessionDate,
                  patientDisplayName: session.patientDisplayName,
                  therapistName: session.therapistName,
                  participants: session.participants || ""
                },
                currentReport: report,
                transcript,
                requiredStyle: {
                  meetingTopic: "משפט קצר וספציפי שמתאר את הקונפליקט/מוקד העבודה",
                  sessionNarrative: "2-4 פסקאות עשירות של מה שנאמר בפגישה, עם שמות, אירועים, רגשות ודפוסים",
                  therapeuticInsights: "1-3 פסקאות של המשגה והתערבויות טיפוליות: שיקופים, שאלות, דימויים, אתגורים והקשרים בין עבר להווה",
                  followUpPoints: "4-7 נקודות מעקב טיפוליות וקונקרטיות",
                  administrativeNotes: "רק מה שנאמר בנושאים מנהליים",
                  crmSummary: "3-4 שורות קצרות ויבשות"
                }
              },
              null,
              2
            )
          }
        ]
      }),
    "העמקת איכות הדוח"
  );

  return JSON.parse(completion.choices[0]?.message?.content || "{}");
}

function reportLooksHebrew(report: any) {
  const text = [
    report?.meetingTopic,
    report?.sessionNarrative,
    report?.therapeuticInsights,
    Array.isArray(report?.followUpPoints) ? report.followUpPoints.join(" ") : "",
    report?.administrativeNotes,
    report?.crmSummary
  ].join(" ");

  const hebrewLetters = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
  return hebrewLetters >= 40 && hebrewLetters >= latinLetters;
}

function reportLooksDetailed(report: any) {
  const narrative = String(report?.sessionNarrative || "");
  const insights = String(report?.therapeuticInsights || "");
  const followUpCount = Array.isArray(report?.followUpPoints) ? report.followUpPoints.length : 0;
  const genericSignals = [
    "קשיים משפחתיים",
    "לחצים משפחתיים ומקצועיים",
    "רצון לשפר את ההבנה העצמית",
    "תמיכה בהתמודדות",
    "תהליך טיפולי ממוקד יותר"
  ].filter((signal) => `${narrative} ${insights}`.includes(signal)).length;

  return narrative.length >= 650 && insights.length >= 450 && followUpCount >= 4 && genericSignals < 2;
}

async function withOpenAiRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  const attempts = Number(process.env.OPENAI_RETRY_ATTEMPTS || 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = getSafeErrorMessage(error);
      if (!isRetryableOpenAiError(message) || attempt === attempts) break;
      console.warn(`${label} נכשל זמנית, ניסיון ${attempt + 1}/${attempts}: ${message}`);
      await delay(1200 * attempt);
    }
  }

  throw lastError;
}

function isRetryableOpenAiError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("connection error") ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("socket") ||
    lower.includes("rate limit") ||
    lower.includes("temporarily")
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAiReport(raw: any, transcript: string) {
  const source = raw?.report || raw?.sessionReport || raw?.["דוח"] || raw || {};
  const internal = raw?.internalSessionMemory || source?.internalSessionMemory || {};

  const meetingTopic = pickString(source, ["meetingTopic", "topic", "נושא המפגש"]);
  const sessionNarrative = pickString(source, ["sessionNarrative", "narrative", "מהלך המפגש"]);
  const therapeuticInsights = pickString(source, [
    "therapeuticInsights",
    "insights",
    "clinicalInsights",
    "תובנות מהתערבויות טיפוליות"
  ]);
  const administrativeNotes = pickString(source, ["administrativeNotes", "adminNotes", "הערות אדמיניסטרטיביות"]);
  const crmSummary = pickString(source, ["crmSummary", "crm", "סיכום קצר ל CRM", "סיכום קצר ל-CRM"]);
  const followUpPoints = pickArray(source, ["followUpPoints", "followUp", "נקודות חשובות למעקב"]);

  const hasContent = [meetingTopic, sessionNarrative, therapeuticInsights, administrativeNotes, crmSummary, ...followUpPoints]
    .some((value) => String(value || "").trim().length > 0);

  if (hasContent) {
    return {
      meetingTopic,
      sessionNarrative,
      therapeuticInsights,
      followUpPoints,
      administrativeNotes,
      crmSummary,
      internalSessionMemory: {
        factsFromSession: pickArray(internal, ["factsFromSession", "facts", "עובדות מהפגישה"]),
        aiInterpretations: pickArray(internal, ["aiInterpretations", "interpretations", "פרשנויות"]),
        interventions: pickArray(internal, ["interventions", "התערבויות"]),
        riskOrUncertaintyNotes: pickArray(internal, ["riskOrUncertaintyNotes", "uncertainties", "אי ודאות"]),
        openQuestionsForNextSession: pickArray(internal, ["openQuestionsForNextSession", "openQuestions", "שאלות להמשך"])
      }
    };
  }

  const transcriptPreview = transcript.trim().slice(0, 900);
  return {
    meetingTopic: "לא זוהה נושא מובנה בתשובת המודל",
    sessionNarrative: transcriptPreview
      ? `תמלול זמני התקבל, אך תשובת הסיכום לא מולאה במבנה הצפוי. קטע תמלול ראשוני לבדיקה: ${transcriptPreview}`
      : "לא התקבל תוכן תמלול מספיק ליצירת מהלך מפגש.",
    therapeuticInsights: "לא הופקו תובנות טיפוליות מובנות. מומלץ לנסות לעבד שוב לאחר בדיקת קובץ האודיו.",
    followUpPoints: ["לנסות להפיק את הדוח שוב.", "אם הבעיה חוזרת, לבדוק את מודל הסיכום שהוגדר בקובץ .env."],
    administrativeNotes: "הדוח נוצר לאחר כשל במיפוי תשובת המודל לשדות הדוח.",
    crmSummary:
      "התקיימה פגישה שתועדה במערכת.\n" +
      "התקבל תמלול זמני, אך לא הופק סיכום מובנה תקין.\n" +
      "נדרש ניסיון עיבוד נוסף או בדיקת הגדרות המודל.\n" +
      "אין להסיק מסקנות טיפוליות מהפלט הנוכחי.",
    internalSessionMemory: {
      factsFromSession: transcriptPreview ? [transcriptPreview] : [],
      aiInterpretations: [],
      interventions: [],
      riskOrUncertaintyNotes: ["תשובת המודל לא מולאה במבנה הדוח הצפוי."],
      openQuestionsForNextSession: []
    }
  };
}

function pickString(source: any, keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map((item) => String(item)).join("\n");
  }
  return "";
}

function pickArray(source: any, keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    if (typeof value === "string" && value.trim()) return value.split("\n").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

const distPath = path.join(process.cwd(), "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

app.listen(port, host, () => {
  console.log(`Server running on http://${host}:${port}`);
});
