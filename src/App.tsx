import { useMemo, useRef, useState } from "react";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import {
  CalendarDays,
  ClipboardCopy,
  FileAudio,
  FileText,
  LogIn,
  LogOut,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Share2,
  Square,
  Trash2,
  UserRound,
  UsersRound
} from "lucide-react";
import { v4 as uuid } from "uuid";
import {
  askSessionQuestion,
  createProgressSummary,
  getProcessingHealth,
  processAudioDraft,
  resumeProcessingJob,
  type ProcessingHealth,
  type ProcessingUpdate
} from "./ai";
import {
  deletePatientFromDrive,
  deleteSessionFromDrive,
  disconnectGoogleDrive,
  getStoredAccessToken,
  isGoogleConfigured,
  isGoogleAuthError,
  loadTherapyDataFromDrive,
  signInWithGoogle,
  syncTherapyDataToDrive,
  uploadSessionAudioToDrive,
  uploadSessionDocxToDrive
} from "./googleDrive";
import { deletePendingAudio, savePendingAudio } from "./offlineAudio";
import { storage } from "./storage";
import type { Patient, SessionReport, TherapySession } from "./types";

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      convertFileSrc?: (path: string) => string;
      Plugins?: {
        NativeGoogleAuth?: {
          signIn: (options: { scopes: string[] }) => Promise<{
            accessToken: string;
            userId?: string;
            email?: string;
            displayName?: string;
          }>;
          signOut?: () => Promise<void>;
        };
        NativeRecorder?: {
          startRecording: () => Promise<{ recording: boolean; startedAt?: number }>;
          getStatus?: () => Promise<{ recording: boolean; startedAt?: number; sizeBytes?: number; lastError?: string }>;
          stopRecording: () => Promise<{ path: string; name: string; mimeType: string; durationMs?: number; sizeBytes?: number }>;
        };
      };
    };
  }
}

type View = "login" | "home" | "patients" | "patient" | "new-recording" | "new-upload" | "session" | "processing";

const emptyReport: SessionReport = {
  title: "דו״ח סיכום פגישה טיפולית",
  meetingTopic: "",
  sessionNarrative: "",
  therapeuticInsights: "",
  followUpPoints: [],
  administrativeNotes: "",
  crmSummary: ""
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timeNow() {
  return new Date().toTimeString().slice(0, 5);
}

function createPatient(displayName: string, ownerUserId: string): Patient {
  const now = new Date().toISOString();
  return {
    patientId: uuid(),
    ownerUserId,
    displayName,
    optionalDetails: {
      fullName: "",
      phone: "",
      age: "",
      treatmentStatus: "",
      generalNotes: ""
    },
    createdAt: now,
    updatedAt: now
  };
}

function createSession(params: {
  patient: Patient;
  therapistName: string;
  sourceType: "recording" | "upload";
  sessionDate: string;
  sessionStartTime: string;
  participants: string;
  sessionType: string;
}): TherapySession {
  const now = new Date().toISOString();
  return {
    sessionId: uuid(),
    ownerUserId: params.patient.ownerUserId,
    patientId: params.patient.patientId,
    patientDisplayName: params.patient.displayName,
    therapistName: params.therapistName,
    sessionDate: params.sessionDate,
    sessionStartTime: params.sessionStartTime,
    sessionType: params.sessionType,
    participants: params.participants,
    durationMinutes: null,
    price: null,
    sourceType: params.sourceType,
    audioStored: false,
    processingStatus: "draft",
    report: emptyReport,
    internalSessionMemory: {
      factsFromSession: [],
      aiInterpretations: [],
      interventions: [],
      riskOrUncertaintyNotes: [],
      openQuestionsForNextSession: []
    },
    createdAt: now,
    updatedAt: now
  };
}

export function App() {
  const [user, setUser] = useState(storage.getUser());
  const [isSignedIn, setIsSignedIn] = useState(Boolean(localStorage.getItem("therapy:signed-in")));
  const [googleAccessToken, setGoogleAccessToken] = useState(getStoredAccessToken());
  const [appMessage, setAppMessage] = useState("");
  const [patients, setPatients] = useState(storage.getPatients());
  const [sessions, setSessions] = useState(storage.getSessions());
  const [view, setView] = useState<View>(isSignedIn ? "home" : "login");
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState("");
  const [dateQuery, setDateQuery] = useState("");
  const [processingHealth, setProcessingHealth] = useState<ProcessingHealth | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  const selectedPatient = patients.find((patient) => patient.patientId === selectedPatientId) || null;
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId) || null;
  const backgroundSessions = sessions.filter(
    (session) => session.processingStatus === "processing" || session.processingStatus === "pending" || session.processingStatus === "failed"
  );

  function syncToDrive(nextPatients: Patient[], nextSessions: TherapySession[]) {
    if (!googleAccessToken) return;
    syncTherapyDataToDrive({
      accessToken: googleAccessToken,
      patients: nextPatients,
      sessions: nextSessions
    }).catch((error) => {
      if (isGoogleAuthError(error)) {
        disconnectGoogleDrive();
        setGoogleAccessToken("");
        setAppMessage("החיבור ל-Google Drive פג. לחץ על ״חבר Google Drive״ ואז שמור שוב.");
        return;
      }
      const message = error instanceof Error ? error.message : "שגיאת סנכרון Google Drive";
      setAppMessage(message);
    });
  }

  function handleDriveError(error: unknown, fallbackMessage: string) {
    if (isGoogleAuthError(error)) {
      disconnectGoogleDrive();
      setGoogleAccessToken("");
      setAppMessage("החיבור ל-Google Drive פג. לחץ על ״חבר Google Drive״ ונסה שוב.");
      return;
    }
    setAppMessage(error instanceof Error ? error.message : fallbackMessage);
  }

  function persistPatients(next: Patient[]) {
    setPatients(next);
    storage.savePatients(next);
    syncToDrive(next, sessions);
  }

  function persistSessions(next: TherapySession[]) {
    setSessions(next);
    storage.saveSessions(next);
    syncToDrive(patients, next);
  }

  function updateSessionLocally(session: TherapySession) {
    setSessions((current) => {
      const next = current.map((item) => (item.sessionId === session.sessionId ? session : item));
      storage.saveSessions(next);
      syncToDrive(patients, next);
      return next;
    });
  }

  async function refreshProcessingSession(sessionId: string) {
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session?.processingJobId) {
      setAppMessage("אין לעיבוד הזה מזהה עבודה פעיל. אפשר לפתוח את הדוח ולנסות להפיק אותו מחדש אם יש אודיו שמור.");
      return;
    }

    setAppMessage(`בודק אם הדוח של ${session.patientDisplayName} מוכן...`);
    try {
      const completed = await resumeProcessingJob(session.processingJobId, (update) => {
        const stage = update.stage || "processing";
        updateSessionLocally({
          ...session,
          processingStatus: "processing",
          processingStage: stage,
          processingMessage: processingStageMessage(stage),
          updatedAt: new Date().toISOString()
        });
      });
      updateSessionLocally({
        ...completed,
        processingJobId: undefined,
        processingStage: undefined,
        processingMessage: undefined,
        updatedAt: new Date().toISOString()
      });
      setAppMessage(`הדוח של ${completed.patientDisplayName} מוכן ונשמר.`);
    } catch (error) {
      setAppMessage(error instanceof Error ? error.message : "בדיקת העיבוד נכשלה.");
    }
  }

  async function refreshAllProcessingSessions() {
    const active = sessions.filter((session) => session.processingStatus === "processing" && session.processingJobId);
    if (active.length === 0) {
      setAppMessage("אין כרגע עיבודים פעילים לבדיקה.");
      return;
    }

    for (const session of active) {
      await refreshProcessingSession(session.sessionId);
    }
  }

  async function checkProcessingHealth() {
    setIsCheckingHealth(true);
    try {
      const health = await getProcessingHealth();
      setProcessingHealth(health);
      setAppMessage(health.ok && health.openai && health.ffmpeg && health.cloudStorage
        ? "מערכת העיבוד זמינה."
        : "מערכת העיבוד מגיבה, אבל חסרה הגדרה אחת או יותר.");
    } catch (error) {
      setAppMessage(error instanceof Error ? `בדיקת מצב המערכת נכשלה: ${error.message}` : "בדיקת מצב המערכת נכשלה.");
    } finally {
      setIsCheckingHealth(false);
    }
  }

  async function signIn() {
    try {
      if (isGoogleConfigured()) {
        const result = await signInWithGoogle();
        setGoogleAccessToken(result.accessToken);
        setUser(result.user);
        storage.saveUser(result.user);
        localStorage.setItem("therapy:signed-in", "true");
        setAppMessage("התחברת עם Google. הנתונים יסונכרנו ל-Drive אחרי שמירה.");
      } else {
        const nextUser = { ...user, displayName: user.displayName || "מטפל/ת" };
        setUser(nextUser);
        storage.saveUser(nextUser);
        localStorage.setItem("therapy:signed-in", "true");
        setAppMessage("מצב דמו פעיל. כדי להתחבר ל-Google צריך להוסיף VITE_GOOGLE_CLIENT_ID לקובץ .env.");
      }
      setIsSignedIn(true);
      setView("home");
    } catch (error) {
      const message = error instanceof Error ? error.message : "הכניסה עם Google נכשלה";
      setAppMessage(message);
    }
  }

  function signInLocalTestMode() {
    const nextUser = {
      ...user,
      userId: "android-local-test",
      email: "local-test@example.local",
      displayName: "בדיקה מקומית"
    };
    setUser(nextUser);
    storage.saveUser(nextUser);
    localStorage.setItem("therapy:signed-in", "true");
    setIsSignedIn(true);
    setView("home");
    setAppMessage("מצב בדיקה מקומי פעיל. Google Drive לא מחובר, אבל אפשר לבדוק הקלטה.");
  }

  async function connectGoogleDrive() {
    try {
      const result = await signInWithGoogle();
      setGoogleAccessToken(result.accessToken);
      setUser(result.user);
      storage.saveUser(result.user);
      localStorage.setItem("therapy:signed-in", "true");
      setIsSignedIn(true);
      setAppMessage("Google Drive חובר. טוען נתונים מה-Drive...");
      const remote = await loadTherapyDataFromDrive(result.accessToken);
      const mergedPatients = mergePatients(remote.patients, patients);
      const mergedSessions = mergeSessions(remote.sessions, sessions);
      setPatients(mergedPatients);
      setSessions(mergedSessions);
      storage.savePatients(mergedPatients);
      storage.saveSessions(mergedSessions);
      await syncTherapyDataToDrive({
        accessToken: result.accessToken,
        patients: mergedPatients,
        sessions: mergedSessions
      });
      setAppMessage("Google Drive חובר. הנתונים נטענו וסונכרנו.");
    } catch (error) {
      handleDriveError(error, "חיבור Google Drive נכשל");
    }
  }

  function upsertSession(session: TherapySession) {
    persistSessions([session, ...sessions.filter((item) => item.sessionId !== session.sessionId)]);
    setSelectedSessionId(session.sessionId);
  }

  async function deleteSession(sessionId: string) {
    const session = sessions.find((item) => item.sessionId === sessionId);
    const nextSessions = sessions.filter((item) => item.sessionId !== sessionId);
    persistSessions(nextSessions);
    if (googleAccessToken && session) {
      try {
        await deleteSessionFromDrive(googleAccessToken, session);
        await syncTherapyDataToDrive({ accessToken: googleAccessToken, patients, sessions: nextSessions });
        setAppMessage("הפגישה נמחקה גם מ-Google Drive.");
      } catch (error) {
        handleDriveError(error, "מחיקה מ-Google Drive נכשלה");
      }
    }
    setSelectedSessionId(null);
    setView("home");
  }

  async function deletePatient(patientId: string) {
    const nextPatients = patients.filter((patient) => patient.patientId !== patientId);
    const nextSessions = sessions.filter((session) => session.patientId !== patientId);
    persistPatients(nextPatients);
    persistSessions(nextSessions);
    if (googleAccessToken) {
      try {
        await deletePatientFromDrive(googleAccessToken, patientId);
        await syncTherapyDataToDrive({ accessToken: googleAccessToken, patients: nextPatients, sessions: nextSessions });
        setAppMessage("המטופל נמחק גם מ-Google Drive.");
      } catch (error) {
        handleDriveError(error, "מחיקה מ-Google Drive נכשלה");
      }
    }
    setSelectedPatientId(null);
    setView("patients");
  }

  function signOut() {
    disconnectGoogleDrive();
    localStorage.removeItem("therapy:signed-in");
    setGoogleAccessToken("");
    setIsSignedIn(false);
    setView("login");
    setAppMessage("התנתקת מהמערכת במכשיר הזה.");
  }

  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      const byName = nameQuery ? session.patientDisplayName.includes(nameQuery) : true;
      const byDate = dateQuery ? session.sessionDate === dateQuery : true;
      return byName && byDate;
    });
  }, [dateQuery, nameQuery, sessions]);

  if (!isSignedIn || view === "login") {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-mark">
            <FileText />
          </div>
          <h1>סיכום פגישות טיפוליות</h1>
          <p>מערכת אישית בעברית להקלטה, עיבוד, עריכה וניהול דוחות טיפוליים.</p>
          {appMessage && <p className="warning">{appMessage}</p>}
          <button className="primary-button" onClick={signIn}>
            <LogIn />
            כניסה עם Google
          </button>
          {isNativeApp() && (
            <button className="secondary-button" onClick={signInLocalTestMode}>
              <Mic />
              כניסה לבדיקה ללא Google
            </button>
          )}
          <span className="small-note">
            {isGoogleConfigured()
              ? "הכניסה תבקש הרשאת Drive מצומצמת מסוג drive.file."
              : "עד הוספת Google Client ID, הכניסה תפעל במצב דמו מקומי."}
          </span>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="ghost-button" onClick={() => setView("home")}>
          <FileText />
          סיכומי טיפול
        </button>
        <div className="user-chip">
          <UserRound />
          <span>{user.displayName}</span>
        </div>
        {isGoogleConfigured() && !googleAccessToken && (
          <button className="secondary-button" onClick={connectGoogleDrive}>
            <Save />
            חבר Google Drive
          </button>
        )}
        {googleAccessToken && <span className="drive-chip">Drive מחובר</span>}
        <button className="secondary-button" onClick={signOut}>
          <LogOut />
          יציאה
        </button>
      </header>
      {appMessage && <div className="app-message">{appMessage}</div>}

      {view === "home" && (
        <section className="page-grid">
          <div className="action-strip">
            <button className="primary-button" onClick={() => setView("new-recording")}>
              <Mic />
              הקלט פגישה חדשה
            </button>
            <button className="secondary-button" onClick={() => setView("new-upload")}>
              <FileAudio />
              העלה קובץ אודיו
            </button>
            <button className="secondary-button" onClick={() => setView("patients")}>
              <UsersRound />
              מטופלים
            </button>
            <button className="secondary-button" onClick={() => setView("processing")}>
              <RefreshCw />
              עיבודים ברקע{backgroundSessions.length ? ` (${backgroundSessions.length})` : ""}
            </button>
          </div>

          {backgroundSessions.length > 0 && (
            <ProcessingQueueSummary
              sessions={backgroundSessions}
              onOpen={(sessionId) => {
                setSelectedSessionId(sessionId);
                setView("session");
              }}
              onRefresh={(sessionId) => refreshProcessingSession(sessionId)}
            />
          )}

          <SystemStatusPanel
            health={processingHealth}
            isChecking={isCheckingHealth}
            onCheck={checkProcessingHealth}
          />

          <section className="toolbar">
            <label>
              <Search />
              <input value={nameQuery} onChange={(event) => setNameQuery(event.target.value)} placeholder="חיפוש לפי שם מטופל" />
            </label>
            <label>
              <CalendarDays />
              <input type="date" value={dateQuery} onChange={(event) => setDateQuery(event.target.value)} />
            </label>
          </section>

          <SessionList
            title="פגישות אחרונות"
            sessions={filteredSessions}
            onOpen={(sessionId) => {
              setSelectedSessionId(sessionId);
              setView("session");
            }}
          />
        </section>
      )}

      {view === "processing" && (
        <ProcessingQueueView
          sessions={backgroundSessions}
          onBack={() => setView("home")}
          onOpen={(sessionId) => {
            setSelectedSessionId(sessionId);
            setView("session");
          }}
          onRefresh={(sessionId) => refreshProcessingSession(sessionId)}
          onRefreshAll={refreshAllProcessingSessions}
        />
      )}

      {view === "patients" && (
        <PatientsView
          patients={patients}
          sessions={sessions}
          onCreate={(displayName) => {
            const patient = createPatient(displayName, user.userId);
            persistPatients([patient, ...patients]);
            setSelectedPatientId(patient.patientId);
            setView("patient");
          }}
          onOpen={(patientId) => {
            setSelectedPatientId(patientId);
            setView("patient");
          }}
        />
      )}

      {view === "patient" && selectedPatient && (
        <PatientView
          patient={selectedPatient}
          sessions={sessions.filter((session) => session.patientId === selectedPatient.patientId)}
          onBack={() => setView("patients")}
          onSave={(patient) => persistPatients(patients.map((item) => (item.patientId === patient.patientId ? patient : item)))}
          onDelete={() => deletePatient(selectedPatient.patientId)}
          onOpenSession={(sessionId) => {
            setSelectedSessionId(sessionId);
            setView("session");
          }}
        />
      )}

      {(view === "new-recording" || view === "new-upload") && (
        <NewSessionView
          mode={view === "new-recording" ? "recording" : "upload"}
          userName={user.displayName}
          googleAccessToken={googleAccessToken}
          patients={patients}
          onCancel={() => setView("home")}
          onCreatePatient={(displayName) => {
            const patient = createPatient(displayName, user.userId);
            persistPatients([patient, ...patients]);
            return patient;
          }}
          onSaved={(session) => {
            upsertSession(session);
            setView("session");
          }}
          onProcessingStarted={(session) => {
            upsertSession(session);
            setSelectedSessionId(session.sessionId);
          }}
        />
      )}

      {view === "session" && selectedSession && (
        <SessionView
          session={selectedSession}
          previousSessions={sessions.filter(
            (session) => session.patientId === selectedSession.patientId && session.sessionId !== selectedSession.sessionId
          )}
          onBack={() => setView("home")}
          onDelete={() => deleteSession(selectedSession.sessionId)}
          onSave={(session) => upsertSession(session)}
        />
      )}
    </main>
  );
}

function mergePatients(primary: Patient[], secondary: Patient[]) {
  const map = new Map<string, Patient>();
  [...secondary, ...primary].forEach((patient) => map.set(patient.patientId, patient));
  return Array.from(map.values());
}

function mergeSessions(primary: TherapySession[], secondary: TherapySession[]) {
  const map = new Map<string, TherapySession>();
  [...secondary, ...primary].forEach((session) => map.set(session.sessionId, session));
  return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ProcessingQueueSummary(props: {
  sessions: TherapySession[];
  onOpen: (sessionId: string) => void;
  onRefresh: (sessionId: string) => void;
}) {
  const activeCount = props.sessions.filter((session) => session.processingStatus === "processing").length;
  const failedCount = props.sessions.filter((session) => session.processingStatus === "failed").length;

  return (
    <section className="queue-banner">
      <div>
        <strong>עיבודים ברקע</strong>
        <span>
          {activeCount > 0 ? `${activeCount} דוחות עדיין בעיבוד` : "אין עיבוד פעיל כרגע"}
          {failedCount > 0 ? ` · ${failedCount} דוחות נכשלו ודורשים בדיקה` : ""}
        </span>
      </div>
      <div className="queue-actions">
        {props.sessions.slice(0, 2).map((session) => (
          <button className="secondary-button" key={session.sessionId} onClick={() => props.onRefresh(session.sessionId)}>
            <RefreshCw />
            בדוק {session.patientDisplayName}
          </button>
        ))}
      </div>
    </section>
  );
}

function ProcessingQueueView(props: {
  sessions: TherapySession[];
  onBack: () => void;
  onOpen: (sessionId: string) => void;
  onRefresh: (sessionId: string) => void;
  onRefreshAll: () => void;
}) {
  const active = props.sessions.filter((session) => session.processingStatus === "processing" || session.processingStatus === "pending");
  const failed = props.sessions.filter((session) => session.processingStatus === "failed");

  return (
    <section className="page-grid">
      <div className="section-title">
        <h1>עיבודים ברקע</h1>
        <button className="secondary-button" onClick={props.onBack}>חזרה</button>
      </div>
      <section className="queue-panel">
        <div className="queue-header">
          <div>
            <strong>{active.length} פעילים</strong>
            <span>{failed.length} נכשלו</span>
          </div>
          <button className="primary-button" onClick={props.onRefreshAll} disabled={active.length === 0}>
            <RefreshCw />
            בדוק את כל הפעילים
          </button>
        </div>
        {props.sessions.length === 0 && <div className="empty-state">אין כרגע דוחות שממתינים לעיבוד או בדיקה.</div>}
        {props.sessions.map((session) => (
          <div className="queue-row" key={session.sessionId}>
            <div>
              <strong>{session.patientDisplayName}</strong>
              <small>{session.sessionDate} · {session.sessionStartTime}</small>
              <span>{session.processingMessage || processingStageMessage(session.processingStage || session.processingStatus)}</span>
            </div>
            <span className={`status status-${session.processingStatus}`}>{statusLabel(session.processingStatus)}</span>
            <div className="queue-actions">
              {session.processingJobId && (
                <button className="secondary-button" onClick={() => props.onRefresh(session.sessionId)}>
                  <RefreshCw />
                  בדוק אם מוכן
                </button>
              )}
              <button className="secondary-button" onClick={() => props.onOpen(session.sessionId)}>
                <FileText />
                פתח דוח
              </button>
            </div>
          </div>
        ))}
      </section>
    </section>
  );
}

function SystemStatusPanel(props: {
  health: ProcessingHealth | null;
  isChecking: boolean;
  onCheck: () => void;
}) {
  const isHealthy = Boolean(props.health?.ok && props.health.openai && props.health.ffmpeg && props.health.cloudStorage);

  return (
    <section className="system-status">
      <div>
        <strong>מצב מערכת</strong>
        <span>
          {props.health
            ? isHealthy
              ? `תקין · מצב עיבוד ${props.health.processingMode}`
              : "יש רכיב שדורש בדיקה"
            : "אפשר לבדוק שהשרת, OpenAI ואחסון הענן זמינים"}
        </span>
      </div>
      {props.health && (
        <div className="health-pills">
          <span className={props.health.openai ? "pill-ok" : "pill-bad"}>OpenAI</span>
          <span className={props.health.ffmpeg ? "pill-ok" : "pill-bad"}>FFmpeg</span>
          <span className={props.health.cloudStorage ? "pill-ok" : "pill-bad"}>Cloud Storage</span>
        </div>
      )}
      <button className="secondary-button" disabled={props.isChecking} onClick={props.onCheck}>
        <RefreshCw />
        {props.isChecking ? "בודק..." : "בדוק מצב"}
      </button>
    </section>
  );
}

function SessionList(props: { title: string; sessions: TherapySession[]; onOpen: (sessionId: string) => void }) {
  return (
    <section>
      <div className="section-title">
        <h2>{props.title}</h2>
      </div>
      <div className="list">
        {props.sessions.length === 0 && <div className="empty-state">אין פגישות להצגה עדיין.</div>}
        {props.sessions.map((session) => (
          <button className="list-row" key={session.sessionId} onClick={() => props.onOpen(session.sessionId)}>
            <span>
              <strong>{session.patientDisplayName}</strong>
              <small>{session.sessionDate} · {session.sessionStartTime}</small>
            </span>
            <span className={`status status-${session.processingStatus}`}>{statusLabel(session.processingStatus)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function processingStageMessage(stage: string) {
  const labels: Record<string, string> = {
    queued: "הדוח ממתין לעיבוד.",
    pending: "הדוח ממתין לעיבוד.",
    audio_received: "האודיו התקבל בשרת.",
    saving_audio_to_cloud: "שומר עותק זמני מאובטח בענן לצורך עיבוד.",
    queued_for_background_processing: "הקובץ נשמר וממתין לעיבוד ברקע.",
    downloading_audio_from_cloud: "טוען את ההקלטה מהאחסון המאובטח.",
    transcribing_and_summarizing: "מתמלל ומפיק דוח. בפגישה ארוכה זה יכול לקחת כמה דקות.",
    processing: "העיבוד עדיין מתבצע.",
    completed: "העיבוד הושלם.",
    failed: "העיבוד נכשל ודורש ניסיון חוזר או בדיקה."
  };
  return labels[stage] || "העיבוד עדיין מתבצע.";
}

function statusLabel(status: TherapySession["processingStatus"]) {
  const labels = {
    draft: "טיוטה",
    pending: "ממתין לעיבוד",
    processing: "בעיבוד",
    completed: "הושלם",
    failed: "נכשל"
  };
  return labels[status];
}

function PatientsView(props: {
  patients: Patient[];
  sessions: TherapySession[];
  onCreate: (displayName: string) => void;
  onOpen: (patientId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [displayName, setDisplayName] = useState("");
  const filtered = props.patients.filter((patient) => patient.displayName.includes(query));

  return (
    <section className="page-grid">
      <div className="section-title">
        <h1>מטופלים</h1>
      </div>
      <section className="toolbar">
        <label>
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="חיפוש לפי שם" />
        </label>
        <label>
          <UserRound />
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="שם תצוגה למטופל חדש" />
        </label>
        <button
          className="primary-button"
          disabled={!displayName.trim()}
          onClick={() => {
            props.onCreate(displayName.trim());
            setDisplayName("");
          }}
        >
          <UsersRound />
          צור מטופל חדש
        </button>
      </section>
      <div className="list">
        {filtered.map((patient) => {
          const patientSessions = props.sessions.filter((session) => session.patientId === patient.patientId);
          const lastSession = patientSessions.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate))[0];
          return (
            <button className="list-row" key={patient.patientId} onClick={() => props.onOpen(patient.patientId)}>
              <span>
                <strong>{patient.displayName}</strong>
                <small>{patientSessions.length} פגישות · אחרונה: {lastSession?.sessionDate || "אין"}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PatientView(props: {
  patient: Patient;
  sessions: TherapySession[];
  onBack: () => void;
  onSave: (patient: Patient) => void;
  onDelete: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState(props.patient);
  const [summaryFrom, setSummaryFrom] = useState("");
  const [summaryTo, setSummaryTo] = useState("");
  const [progressSummary, setProgressSummary] = useState("");
  const [summaryStatus, setSummaryStatus] = useState("");

  function updateOptional(key: keyof Patient["optionalDetails"], value: string) {
    setDraft({ ...draft, optionalDetails: { ...draft.optionalDetails, [key]: value }, updatedAt: new Date().toISOString() });
  }

  return (
    <section className="page-grid">
      <div className="section-title">
        <h1>כרטיס מטופל</h1>
        <button className="secondary-button" onClick={props.onBack}>חזרה</button>
      </div>
      <section className="form-grid">
        <label>שם תצוגה<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label>שם מלא או פיקטיבי<input value={draft.optionalDetails.fullName} onChange={(event) => updateOptional("fullName", event.target.value)} /></label>
        <label>טלפון<input value={draft.optionalDetails.phone} onChange={(event) => updateOptional("phone", event.target.value)} /></label>
        <label>גיל<input value={draft.optionalDetails.age} onChange={(event) => updateOptional("age", event.target.value)} /></label>
        <label>סטטוס טיפול<input value={draft.optionalDetails.treatmentStatus} onChange={(event) => updateOptional("treatmentStatus", event.target.value)} /></label>
        <label className="wide">הערות כלליות<textarea value={draft.optionalDetails.generalNotes} onChange={(event) => updateOptional("generalNotes", event.target.value)} /></label>
      </section>
      <div className="action-strip">
        <button className="primary-button" onClick={() => props.onSave({ ...draft, updatedAt: new Date().toISOString() })}><Save /> שמור</button>
        <button className="danger-button" onClick={props.onDelete}><Trash2 /> מחק מטופל</button>
      </div>
      <section className="chat-panel">
        <h2>סיכום התקדמות</h2>
        <div className="toolbar">
          <label>
            <CalendarDays />
            <input type="date" value={summaryFrom} onChange={(event) => setSummaryFrom(event.target.value)} />
          </label>
          <label>
            <CalendarDays />
            <input type="date" value={summaryTo} onChange={(event) => setSummaryTo(event.target.value)} />
          </label>
          <button
            className="secondary-button"
            onClick={async () => {
              setSummaryStatus("מפיק סיכום...");
              try {
                const from = summaryFrom || "0000-01-01";
                const to = summaryTo || "9999-12-31";
                const relevantSessions = props.sessions.filter(
                  (session) => session.sessionDate >= from && session.sessionDate <= to
                );
                const summary = await createProgressSummary({
                  patientDisplayName: props.patient.displayName,
                  dateFrom: summaryFrom || "תחילת הטיפול",
                  dateTo: summaryTo || "היום",
                  sessions: relevantSessions
                });
                setProgressSummary(summary);
                setSummaryStatus("סיכום התקדמות הופק.");
              } catch (error) {
                setSummaryStatus(error instanceof Error ? error.message : "לא הצלחנו להפיק סיכום התקדמות.");
              }
            }}
          >
            <FileText />
            הפק סיכום התקדמות
          </button>
        </div>
        {summaryStatus && <p className="success-message">{summaryStatus}</p>}
        {progressSummary && <textarea value={progressSummary} onChange={(event) => setProgressSummary(event.target.value)} />}
      </section>
      <SessionList title="פגישות המטופל" sessions={props.sessions} onOpen={props.onOpenSession} />
    </section>
  );
}

function NewSessionView(props: {
  mode: "recording" | "upload";
  userName: string;
  googleAccessToken: string;
  patients: Patient[];
  onCancel: () => void;
  onCreatePatient: (displayName: string) => Patient;
  onSaved: (session: TherapySession) => void;
  onProcessingStarted: (session: TherapySession) => void;
}) {
  const [patientName, setPatientName] = useState("");
  const [date, setDate] = useState(today());
  const [time, setTime] = useState(timeNow());
  const [participants, setParticipants] = useState("");
  const [sessionType, setSessionType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recordingMessage, setRecordingMessage] = useState("");
  const [nativeRecording, setNativeRecording] = useState(false);
  const [saveOriginalAudio, setSaveOriginalAudio] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const nativeStartedAtRef = useRef<number | null>(null);

  async function startRecording() {
    try {
      if (isNativeRecorderAvailable()) {
        const result = await window.Capacitor!.Plugins!.NativeRecorder!.startRecording();
        const startedAt = result.startedAt || Date.now();
        nativeStartedAtRef.current = startedAt;
        setRecordedBlob(null);
        setSeconds(0);
        setNativeRecording(true);
        setRecording(true);
        setRecordingMessage("הקלטה Native פעילה. אפשר לכבות מסך, אך אין לסגור את האפליקציה.");
        timerRef.current = window.setInterval(() => {
          setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        }, 1000);
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setRecordingMessage("הדפדפן לא תומך בהקלטת מיקרופון.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      setRecordedBlob(null);
      setSeconds(0);
      setRecordingMessage("ההקלטה פעילה. מומלץ להשאיר את המסך פתוח.");
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        setRecordedBlob(new Blob(chunksRef.current, { type: "audio/webm" }));
        setRecordingMessage("ההקלטה נשמרה זמנית ומוכנה לעיבוד.");
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      timerRef.current = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "לא הצלחנו לקבל הרשאת מיקרופון.";
      setRecordingMessage(`לא הצלחנו להתחיל הקלטה: ${message}`);
    }
  }

  async function stopRecording() {
    if (nativeRecording && isNativeRecorderAvailable()) {
      try {
        const result = await window.Capacitor!.Plugins!.NativeRecorder!.stopRecording();
        const webPath = window.Capacitor!.convertFileSrc ? window.Capacitor!.convertFileSrc(result.path) : result.path;
        const response = await fetch(webPath);
        const blob = await response.blob();
        setRecordedBlob(new Blob([blob], { type: result.mimeType || "audio/mp4" }));
        const durationSeconds = result.durationMs ? Math.round(result.durationMs / 1000) : 0;
        const sizeMb = result.sizeBytes ? (result.sizeBytes / 1024 / 1024).toFixed(1) : "";
        setSeconds(durationSeconds || seconds);
        setRecordingMessage(
          `הקלטת Native נשמרה זמנית ומוכנה לעיבוד.${durationSeconds ? ` משך בפועל: ${formatDuration(durationSeconds)}.` : ""}${sizeMb ? ` גודל: ${sizeMb}MB.` : ""}`
        );
      } catch (error) {
        setRecordingMessage(error instanceof Error ? error.message : "לא הצלחנו לעצור הקלטה Native.");
      }
      setNativeRecording(false);
      nativeStartedAtRef.current = null;
    } else {
      mediaRecorderRef.current?.stop();
    }

    if (timerRef.current) window.clearInterval(timerRef.current);
    setRecording(false);
  }

  function updateProcessingMessage(update: ProcessingUpdate) {
    if (update.phase === "warming") {
      setRecordingMessage("מכין את שרת העיבוד...");
      return;
    }
    if (update.phase === "uploading") {
      setRecordingMessage(`מעלה את קובץ האודיו${typeof update.percent === "number" ? ` (${update.percent}%)` : ""}...`);
      return;
    }

    const labels: Record<string, string> = {
      queued: "הדוח ממתין לעיבוד.",
      audio_received: "האודיו התקבל בשרת.",
      saving_audio_to_cloud: "שומר עותק זמני מאובטח בענן לצורך עיבוד.",
      queued_for_background_processing: "הקובץ נשמר וממתין לעיבוד ברקע.",
      downloading_audio_from_cloud: "טוען את ההקלטה מהאחסון המאובטח.",
      transcribing_and_summarizing: "מתמלל את ההקלטה ומפיק דוח. זה יכול לקחת כמה דקות בפגישה ארוכה.",
      processing: "מעבד את ההקלטה.",
      completed: "העיבוד הושלם."
    };
    setRecordingMessage(labels[update.stage || ""] || "מעבד את ההקלטה. אפשר להמתין עד שהדוח ייפתח.");
  }

  async function process() {
    const displayName = patientName.trim();
    if (!displayName) return;
    const audio = file || recordedBlob;
    if (!audio) {
      setRecordingMessage(
        props.mode === "recording"
          ? "יש להתחיל הקלטה, לעצור אותה, ורק אחרי שמופיעה הודעה שההקלטה מוכנה לעיבוד להפיק דו״ח."
          : "יש לבחור קובץ אודיו לפני הפקת דו״ח."
      );
      return;
    }
    const patient = props.patients.find((item) => item.displayName === displayName) || props.onCreatePatient(displayName);
    const session = createSession({
      patient,
      therapistName: props.userName,
      sourceType: props.mode,
      sessionDate: date,
      sessionStartTime: time,
      participants,
      sessionType
    });
    let sessionForProcessing = session;
    let storedAudioMeta: Pick<TherapySession, "audioStored" | "audioFileName" | "audioMimeType"> | null = null;
    setIsProcessing(true);
    try {
      if (saveOriginalAudio && props.googleAccessToken) {
        const audioFileName = buildAudioFileName(session, audio, file?.name);
        try {
          await uploadSessionAudioToDrive(props.googleAccessToken, session, audio, audioFileName);
          storedAudioMeta = {
            audioStored: true,
            audioFileName,
            audioMimeType: audio.type || "application/octet-stream"
          };
          sessionForProcessing = {
            ...session,
            ...storedAudioMeta,
            updatedAt: new Date().toISOString()
          };
          setRecordingMessage("קובץ האודיו המקורי נשמר ב-Google Drive. ממשיך לעיבוד הדוח.");
        } catch (error) {
          if (isGoogleAuthError(error)) {
            disconnectGoogleDrive();
          }
          const message = error instanceof Error ? error.message : "שמירת האודיו ל-Google Drive נכשלה.";
          setRecordingMessage(`שמירת האודיו ל-Google Drive נכשלה, אבל ממשיכים להפיק דוח. לאחר מכן חבר Google Drive מחדש. ${message}`);
        }
      }

      const completed = await processAudioDraft(
        { ...sessionForProcessing, processingStatus: "processing" },
        audio,
        {
          onUpdate: updateProcessingMessage,
          onJobStarted: (jobId) => {
            const processingSession: TherapySession = {
              ...sessionForProcessing,
              processingStatus: "processing",
              processingJobId: jobId,
              processingStage: "queued",
              processingMessage: "ההקלטה נשלחה לעיבוד ברקע. אפשר לחזור לדוח מאוחר יותר ולבדוק אם הוא מוכן.",
              updatedAt: new Date().toISOString()
            };
            props.onProcessingStarted(processingSession);
          }
        }
      );
      let finalSession = completed;
      if (storedAudioMeta) {
        finalSession = {
          ...completed,
          ...storedAudioMeta,
          updatedAt: new Date().toISOString()
        };
      }
      finalSession = {
        ...finalSession,
        processingJobId: undefined,
        processingStage: undefined,
        processingMessage: undefined
      };
      await deletePendingAudio(sessionForProcessing.sessionId);
      props.onSaved(finalSession);
    } catch (error) {
      if (audio) {
        await savePendingAudio(sessionForProcessing.sessionId, audio, {
          patientDisplayName: sessionForProcessing.patientDisplayName,
          sessionDate: sessionForProcessing.sessionDate,
          sourceType: sessionForProcessing.sourceType
        });
      }
      const message = error instanceof Error ? error.message : "לא הצלחנו להפיק דו״ח. אפשר לנסות שוב.";
      props.onSaved(buildFailedSession(sessionForProcessing, message, navigator.onLine ? "failed" : "pending"));
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <section className="page-grid">
      <div className="section-title">
        <h1>{props.mode === "recording" ? "פגישה חדשה מתוך הקלטה" : "העלאת קובץ אודיו"}</h1>
        <button className="secondary-button" onClick={props.onCancel}>חזרה</button>
      </div>
      <p className="warning">כדי למנוע עצירת הקלטה, מומלץ להשאיר את המסך פתוח עד סיום הפגישה.</p>
      <section className="form-grid">
        <label>שם מטופל או בחירה קיימת<input list="patients" value={patientName} onChange={(event) => setPatientName(event.target.value)} /></label>
        <datalist id="patients">{props.patients.map((patient) => <option key={patient.patientId} value={patient.displayName} />)}</datalist>
        <label>תאריך פגישה<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>שעת התחלה<input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <label>שם מטפל<input value={props.userName} readOnly /></label>
        <label>סוג פגישה<input value={sessionType} onChange={(event) => setSessionType(event.target.value)} /></label>
        <label>נוכחים בפגישה<input value={participants} onChange={(event) => setParticipants(event.target.value)} /></label>
      </section>
      {props.mode === "recording" ? (
        <section className="recorder-panel">
          <strong>{new Date(seconds * 1000).toISOString().slice(11, 19)}</strong>
          <div className="action-strip">
            {!recording && <button className="primary-button" onClick={startRecording}><Play /> התחל הקלטה</button>}
            {recording && <button className="danger-button" onClick={stopRecording}><Square /> עצירה</button>}
            <button className="secondary-button" disabled><Pause /> השהיה</button>
          </div>
          {recordedBlob && (
            <span className="small-note">
              הקלטה זמנית מוכנה לעיבוד. האודיו יישמר רק אם תסמן במפורש שמירת אודיו מקורי.
            </span>
          )}
          {recordingMessage && <span className={recording ? "success-message" : "small-note"}>{recordingMessage}</span>}
        </section>
      ) : (
        <section className="upload-panel">
          <input type="file" accept="audio/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          {file && <span>{file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB</span>}
        </section>
      )}
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={saveOriginalAudio}
          disabled={!props.googleAccessToken}
          onChange={(event) => setSaveOriginalAudio(event.target.checked)}
        />
        שמור את קובץ האודיו המקורי ב-Google Drive
      </label>
      {!props.googleAccessToken && (
        <span className="small-note">כדי לשמור אודיו מקורי צריך קודם לחבר Google Drive. ברירת המחדל נשארת לא לשמור אודיו.</span>
      )}
      {saveOriginalAudio && (
        <p className="warning">שים לב: שמירת אודיו מגדילה משמעותית את רגישות המידע ואת נפח האחסון ב-Drive.</p>
      )}
      <button className="primary-button" disabled={isProcessing || recording || !patientName.trim() || !(file || recordedBlob)} onClick={process}>
        <FileText />
        {isProcessing ? "מעבד..." : "הפק דו״ח"}
      </button>
    </section>
  );
}

function isNativeRecorderAvailable() {
  return Boolean(
    window.Capacitor?.isNativePlatform?.() &&
      window.Capacitor?.Plugins?.NativeRecorder?.startRecording &&
      window.Capacitor?.Plugins?.NativeRecorder?.stopRecording
  );
}

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

function buildAudioFileName(session: TherapySession, audio: Blob, originalName?: string) {
  const safeOriginalName = originalName?.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (safeOriginalName) return `session_${session.sessionId}_${safeOriginalName}`;
  const extension = audioExtensionFromMime(audio.type);
  return `session_${session.sessionId}_original_audio.${extension}`;
}

function audioExtensionFromMime(mimeType: string) {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  return "audio";
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function buildFailedSession(session: TherapySession, message: string, status: TherapySession["processingStatus"]): TherapySession {
  return {
    ...session,
    processingStatus: status,
    report: {
      title: "דו״ח סיכום פגישה טיפולית",
      meetingTopic: "העיבוד נכשל",
      sessionNarrative:
        "לא נוצר דוח מהאודיו. ההקלטה נשמרה זמנית בדפדפן אם הייתה זמינה, כדי לאפשר ניסיון חוזר.",
      therapeuticInsights: "לא הופקו תובנות טיפוליות משום שהעיבוד האוטומטי נכשל.",
      followUpPoints: [
        "לבדוק שהקובץ הוא קובץ אודיו תקין ולא גדול מדי.",
        "לבדוק את הודעת השגיאה ולנסות שוב.",
        "אם השגיאה קשורה למודל, לעדכן את שמות המודלים בקובץ .env."
      ],
      administrativeNotes: `שגיאת עיבוד: ${message}`,
      crmSummary:
        "לא הופק סיכום CRM משום שעיבוד האודיו נכשל.\n" +
        "יש לנסות לעבד מחדש לאחר בדיקת הקובץ והגדרות ה-API.\n" +
        "אין להסיק מסקנות טיפוליות מהפלט הנוכחי.\n" +
        `פרטי שגיאה: ${message.slice(0, 180)}`
    },
    internalSessionMemory: {
      factsFromSession: [],
      aiInterpretations: [],
      interventions: [],
      riskOrUncertaintyNotes: [message],
      openQuestionsForNextSession: []
    },
    updatedAt: new Date().toISOString()
  };
}

function SessionView(props: {
  session: TherapySession;
  previousSessions: TherapySession[];
  onBack: () => void;
  onDelete: () => void;
  onSave: (session: TherapySession) => void;
}) {
  const [draft, setDraft] = useState(props.session);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [isCheckingJob, setIsCheckingJob] = useState(false);

  function updateReport(key: keyof SessionReport, value: string | string[]) {
    setDraft({ ...draft, report: { ...draft.report, [key]: value }, updatedAt: new Date().toISOString() });
  }

  async function ask(allPatientSessions: boolean) {
    if (!question.trim()) return;
    const response = await askSessionQuestion({
      question,
      session: draft,
      previousSessions: allPatientSessions ? props.previousSessions : []
    });
    setAnswer(response);
  }

  async function shareText(text: string) {
    try {
      const isLikelyMobile = window.matchMedia("(pointer: coarse)").matches;
      if (navigator.share && isLikelyMobile) {
        await navigator.share({ text });
        setStatusMessage("תפריט השיתוף נפתח.");
      } else {
        await navigator.clipboard.writeText(text);
        setStatusMessage("הדוח הועתק ללוח. במחשב זה אמין יותר מתפריט השיתוף של הדפדפן.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("השיתוף בוטל.");
        return;
      }
      await navigator.clipboard.writeText(text);
      setStatusMessage("השיתוף לא נפתח, אז הדוח הועתק ללוח.");
    }
  }

  async function copyCrmSummary() {
    await navigator.clipboard.writeText(draft.report.crmSummary || "");
    setStatusMessage("סיכום ה-CRM הועתק ללוח.");
  }

  function saveDraft() {
    props.onSave(draft);
    setStatusMessage("הדוח נשמר מקומית במכשיר.");
  }

  function updateJobMessage(update: ProcessingUpdate) {
    const stage = update.stage || "processing";
    const message = processingStageMessage(stage);
    setDraft((current) => ({
      ...current,
      processingStatus: "processing",
      processingStage: stage,
      processingMessage: message,
      updatedAt: new Date().toISOString()
    }));
    setStatusMessage(message);
  }

  async function checkProcessingJob() {
    if (!draft.processingJobId) return;
    setIsCheckingJob(true);
    setStatusMessage("בודק אם הדוח מוכן...");
    try {
      const completed = await resumeProcessingJob(draft.processingJobId, updateJobMessage);
      const nextSession: TherapySession = {
        ...completed,
        processingJobId: undefined,
        processingStage: undefined,
        processingMessage: undefined,
        updatedAt: new Date().toISOString()
      };
      setDraft(nextSession);
      props.onSave(nextSession);
      setStatusMessage("הדוח מוכן ונשמר במכשיר.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "הדוח עדיין לא מוכן או שהבדיקה נכשלה.");
    } finally {
      setIsCheckingJob(false);
    }
  }

  const reportText = formatReport(draft);

  return (
    <section className="page-grid">
      <div className="section-title">
        <h1>דוח פגישה</h1>
        <button className="secondary-button" onClick={props.onBack}>חזרה</button>
      </div>
      <section className="report-editor">
        <h2>דו״ח סיכום פגישה טיפולית</h2>
        {draft.processingStatus === "failed" && (
          <p className="warning">{draft.report.administrativeNotes || "לא הצלחנו להפיק דו״ח. אפשר לנסות שוב."}</p>
        )}
        {draft.processingStatus === "processing" && draft.processingJobId && (
          <div className="warning">
            <strong>הדוח עדיין בעיבוד ברקע.</strong>
            <p>{draft.processingMessage || "אפשר לחזור למסך הזה ולבדוק אם הדוח מוכן."}</p>
            <button className="secondary-button" disabled={isCheckingJob} onClick={checkProcessingJob}>
              <FileText />
              {isCheckingJob ? "בודק..." : "בדוק אם הדוח מוכן"}
            </button>
          </div>
        )}
        {statusMessage && <p className="success-message">{statusMessage}</p>}
        <div className="meta-grid">
          <span>תאריך המפגש: {draft.sessionDate}</span>
          <span>שם המטופל/ת: {draft.patientDisplayName}</span>
          <span>שם המטפל/ת: {draft.therapistName}</span>
          <span>אודיו מקור: {draft.audioStored ? "נשמר ב-Google Drive" : "לא נשמר"}</span>
        </div>
        <label>נושא המפגש<textarea value={draft.report.meetingTopic} onChange={(event) => updateReport("meetingTopic", event.target.value)} /></label>
        <label>מהלך המפגש<textarea value={draft.report.sessionNarrative} onChange={(event) => updateReport("sessionNarrative", event.target.value)} /></label>
        <label>תובנות מהתערבויות טיפוליות<textarea value={draft.report.therapeuticInsights} onChange={(event) => updateReport("therapeuticInsights", event.target.value)} /></label>
        <label>נקודות חשובות למעקב<textarea value={draft.report.followUpPoints.join("\n")} onChange={(event) => updateReport("followUpPoints", event.target.value.split("\n").filter(Boolean))} /></label>
        <label>הערות אדמיניסטרטיביות<textarea value={draft.report.administrativeNotes} onChange={(event) => updateReport("administrativeNotes", event.target.value)} /></label>
        <label>סיכום קצר ל CRM<textarea value={draft.report.crmSummary} onChange={(event) => updateReport("crmSummary", event.target.value)} /></label>
      </section>
      <div className="action-strip">
        <button className="primary-button" onClick={saveDraft}><Save /> שמור</button>
        <button className="secondary-button" onClick={() => shareText(reportText)}><Share2 /> שתף טקסט</button>
        <button className="secondary-button" onClick={copyCrmSummary}><ClipboardCopy /> העתק סיכום CRM</button>
        <button className="secondary-button" onClick={async () => {
          const blob = await createDocxBlob(draft);
          downloadBlob(blob, `session_${draft.sessionId}.docx`);
          if (getStoredAccessToken()) {
            await uploadSessionDocxToDrive(getStoredAccessToken(), draft, blob);
            setStatusMessage("קובץ Word נוצר, ירד למחשב ונשמר ב-Google Drive.");
          } else {
            setStatusMessage("קובץ Word נוצר ונשלח להורדה.");
          }
        }}><FileText /> ייצא Word</button>
        <button className="danger-button" onClick={props.onDelete}><Trash2 /> מחק פגישה</button>
      </div>
      <section className="chat-panel">
        <h2>שיחה עם הפגישה</h2>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="שאל שאלה על הפגישה או על רצף הפגישות" />
        <div className="action-strip">
          <button className="secondary-button" onClick={() => ask(false)}><Send /> שאל על הפגישה</button>
          <button className="secondary-button" onClick={() => ask(true)}><Send /> שאל על כל פגישות המטופל</button>
        </div>
        {answer && <p className="answer">{answer}</p>}
      </section>
    </section>
  );
}

function formatReport(session: TherapySession) {
  return [
    "דו״ח סיכום פגישה טיפולית",
    "",
    `תאריך המפגש: ${session.sessionDate}`,
    `שם המטופל/ת: ${session.patientDisplayName}`,
    `שם המטפל/ת: ${session.therapistName}`,
    "",
    "נושא המפגש",
    session.report.meetingTopic,
    "",
    "מהלך המפגש",
    session.report.sessionNarrative,
    "",
    "תובנות מהתערבויות טיפוליות",
    session.report.therapeuticInsights,
    "",
    "נקודות חשובות למעקב",
    session.report.followUpPoints.map((point) => `• ${point}`).join("\n"),
    "",
    "הערות אדמיניסטרטיביות",
    session.report.administrativeNotes,
    "",
    "סיכום קצר ל CRM",
    session.report.crmSummary
  ].join("\n");
}

async function createDocxBlob(session: TherapySession) {
  const paragraph = (text: string, bold = false) =>
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      spacing: { after: 180 },
      children: [new TextRun({ text, bold, rightToLeft: true })]
    });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: "דו״ח סיכום פגישה טיפולית",
            heading: HeadingLevel.TITLE,
            bidirectional: true,
            alignment: AlignmentType.RIGHT
          }),
          paragraph(`תאריך המפגש: ${session.sessionDate}`),
          paragraph(`שם המטופל/ת: ${session.patientDisplayName}`),
          paragraph(`שם המטפל/ת: ${session.therapistName}`),
          paragraph("נושא המפגש", true),
          paragraph(session.report.meetingTopic),
          paragraph("מהלך המפגש", true),
          paragraph(session.report.sessionNarrative),
          paragraph("תובנות מהתערבויות טיפוליות", true),
          paragraph(session.report.therapeuticInsights),
          paragraph("נקודות חשובות למעקב", true),
          ...session.report.followUpPoints.map((point) => paragraph(point)),
          paragraph("הערות אדמיניסטרטיביות", true),
          paragraph(session.report.administrativeNotes),
          paragraph("סיכום קצר ל CRM", true),
          paragraph(session.report.crmSummary)
        ]
      }
    ]
  });
  return Packer.toBlob(doc);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
