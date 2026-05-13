import express from "express";
import "dotenv/config";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }
});
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const DIRECT_TRANSCRIBE_LIMIT_BYTES = Number(process.env.DIRECT_TRANSCRIBE_LIMIT_BYTES || 8 * 1024 * 1024);
const PROCESSING_JOB_TTL_MS = Number(process.env.PROCESSING_JOB_TTL_MS || 2 * 60 * 60 * 1000);

type ProcessingJob = {
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  message?: string;
};

const processingJobs = new Map<string, ProcessingJob>();

app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, openai: Boolean(openai), ffmpeg: Boolean(ffmpegPath) });
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
  processingJobs.set(jobId, { status: "queued", createdAt: now, updatedAt: now });
  res.status(202).json({ jobId, status: "queued" });

  void runProcessingJob(jobId, session, file);
});

app.get("/api/process-session-job/:jobId", (req, res) => {
  const job = processingJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "job_not_found", message: "עבודת העיבוד לא נמצאה. ייתכן שהשרת הופעל מחדש או שהעיבוד ישן מדי." });
    return;
  }

  if (job.status === "completed") {
    res.json({ status: job.status, result: job.result });
    return;
  }

  if (job.status === "failed") {
    res.status(500).json({ status: job.status, error: "processing_failed", message: job.message || "עיבוד האודיו נכשל." });
    return;
  }

  res.json({ status: job.status });
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
  let aiReport = normalizeAiReport(await createTherapyReport(session, transcript), transcript);
  if (!reportLooksHebrew(aiReport)) {
    aiReport = normalizeAiReport(await rewriteReportInHebrew(session, aiReport), transcript);
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

function updateProcessingJob(jobId: string, patch: Partial<ProcessingJob>) {
  const current = processingJobs.get(jobId);
  if (!current) return;
  processingJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function cloneUploadedFile(file: Express.Multer.File): Express.Multer.File {
  return {
    ...file,
    buffer: Buffer.from(file.buffer)
  };
}

async function transcribeAudio(file: Express.Multer.File) {
  if (!openai) throw new Error("missing_openai_client");

  if (file.size <= DIRECT_TRANSCRIBE_LIMIT_BYTES && isDirectTranscriptionMime(file.mimetype)) {
    try {
      const transcription = await transcribeBuffer(
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
      const transcription = await transcribeBuffer(buffer, path.basename(chunk), "audio/mpeg", `תמלול מקטע ${index + 1}`);

      const text = typeof transcription === "string" ? transcription : String(transcription);
      transcripts.push(`[מקטע ${index + 1}]\n${text}`);
    }
  } finally {
    await cleanupChunks(chunks);
  }

  return transcripts.join("\n\n");
}

async function transcribeBuffer(buffer: Buffer, fileName: string, mimeType: string, label: string) {
  if (!openai) throw new Error("missing_openai_client");
  const openAiFile = await toFile(buffer, fileName, { type: mimeType });
  return withOpenAiRetry(
    () =>
      openai.audio.transcriptions.create({
        file: openAiFile,
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
        response_format: "text"
      }),
    label
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
              "אתה מסייע למטפל לנסח דו״ח סיכום פגישה טיפולית בעברית בלבד. כל ערכי הטקסט בדוח חייבים להיות בעברית, גם אם התמלול, שמות המשתתפים או חלק מהשיחה באנגלית. החזר JSON תקין בלבד, ללא Markdown וללא טקסט מסביב. חובה להשתמש בשמות השדות באנגלית בדיוק כפי שמופיעים בסכמה. כתוב בגוף שלישי, בניסוח מקצועי, זהיר ולא אבחוני מדי. הפרד בין מידע שנאמר בפגישה לבין פרשנות טיפולית. אל תמציא פרטים."
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

החזר JSON במבנה הזה בדיוק. שמות השדות חייבים להישאר באנגלית:
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
              "תקן דוח פגישה טיפולית כך שכל ערכי הטקסט יהיו בעברית בלבד. שמות השדות חייבים להישאר באנגלית בדיוק. אל תוסיף פרטים חדשים ואל תשנה עובדות. אם יש שמות פרטיים, השאר אותם כפי שנמסרו או תעתק לעברית אם טבעי. החזר JSON תקין בלבד."
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
