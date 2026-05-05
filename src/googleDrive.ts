import type { Patient, TherapySession, UserProfile } from "./types";

const APP_FOLDER_NAME = "Therapy Session Reports";
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file"
].join(" ");

type TokenResponse = {
  access_token?: string;
  error?: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: TokenResponse) => void;
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void;
          };
        };
      };
    };
  }
}

export function isGoogleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID);
}

export async function signInWithGoogle(): Promise<{ user: UserProfile; accessToken: string }> {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("חסר VITE_GOOGLE_CLIENT_ID בקובץ .env");
  }

  if (isNativeGoogleAuthAvailable()) {
    return signInWithNativeGoogle();
  }

  await waitForGoogleIdentity();
  const accessToken = await requestAccessToken();
  const profile = await fetchGoogleProfile(accessToken);

  const user: UserProfile = {
    userId: profile.sub,
    email: profile.email,
    displayName: profile.name || profile.email,
    createdAt: new Date().toISOString(),
    settings: {
      defaultLanguage: "he",
      saveAudioAfterProcessing: false,
      exportFormat: "docx"
    }
  };

  sessionStorage.setItem("therapy:google-access-token", accessToken);
  return { user, accessToken };
}

export function getStoredAccessToken() {
  return sessionStorage.getItem("therapy:google-access-token") || "";
}

export function disconnectGoogleDrive() {
  sessionStorage.removeItem("therapy:google-access-token");
  if (isNativeGoogleAuthAvailable()) {
    window.Capacitor!.Plugins!.NativeGoogleAuth!.signOut?.().catch(() => undefined);
  }
}

export function isGoogleAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Google Drive: 401") || message.includes("invalid authentication credentials");
}

export async function syncTherapyDataToDrive(payload: {
  accessToken: string;
  patients: Patient[];
  sessions: TherapySession[];
}) {
  if (!payload.accessToken) return;
  const folderId = await ensureAppFolder(payload.accessToken);
  const patientsFolderId = await ensureChildFolder(payload.accessToken, folderId, "patients");
  await uploadJsonFile(payload.accessToken, folderId, "patients_index.json", buildPatientsIndex(payload.patients, payload.sessions));
  await uploadJsonFile(payload.accessToken, folderId, "sessions_index.json", payload.sessions);

  for (const patient of payload.patients) {
    const patientFolderId = await ensureChildFolder(payload.accessToken, patientsFolderId, `patient_${patient.patientId}`);
    const sessionsFolderId = await ensureChildFolder(payload.accessToken, patientFolderId, "sessions");
    await ensureChildFolder(payload.accessToken, patientFolderId, "exports");
    await uploadJsonFile(payload.accessToken, patientFolderId, "patient.json", patient);

    const patientSessions = payload.sessions.filter((session) => session.patientId === patient.patientId);
    for (const session of patientSessions) {
      await uploadJsonFile(payload.accessToken, sessionsFolderId, `session_${session.sessionId}.json`, session);
    }
  }
}

export async function uploadDocxToDrive(accessToken: string, fileName: string, blob: Blob) {
  const folderId = await ensureAppFolder(accessToken);
  const existing = await findFile(accessToken, folderId, fileName);
  const metadata = {
    name: fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    parents: existing ? undefined : [folderId]
  };
  const body = new FormData();
  body.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.set("file", blob);

  const path = existing
    ? `/upload/drive/v3/files/${existing}?uploadType=multipart`
    : "/upload/drive/v3/files?uploadType=multipart";
  await driveFetch(accessToken, path, {
    method: existing ? "PATCH" : "POST",
    body
  });
}

export async function uploadSessionDocxToDrive(accessToken: string, session: TherapySession, blob: Blob) {
  const folderId = await ensureAppFolder(accessToken);
  const patientsFolderId = await ensureChildFolder(accessToken, folderId, "patients");
  const patientFolderId = await ensureChildFolder(accessToken, patientsFolderId, `patient_${session.patientId}`);
  const exportsFolderId = await ensureChildFolder(accessToken, patientFolderId, "exports");
  await uploadBlobFile(
    accessToken,
    exportsFolderId,
    `session_${session.sessionId}.docx`,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    blob
  );
  await uploadDocxToDrive(accessToken, `session_${session.sessionId}.docx`, blob);
}

export async function deleteSessionFromDrive(accessToken: string, session: TherapySession) {
  const folderId = await ensureAppFolder(accessToken);
  const patientsFolderId = await findFile(accessToken, folderId, "patients");
  if (patientsFolderId) {
    const patientFolderId = await findFile(accessToken, patientsFolderId, `patient_${session.patientId}`);
    if (patientFolderId) {
      const sessionsFolderId = await findFile(accessToken, patientFolderId, "sessions");
      const exportsFolderId = await findFile(accessToken, patientFolderId, "exports");
      if (sessionsFolderId) {
        const sessionFileId = await findFile(accessToken, sessionsFolderId, `session_${session.sessionId}.json`);
        if (sessionFileId) await deleteDriveFile(accessToken, sessionFileId);
      }
      if (exportsFolderId) {
        const docxFileId = await findFile(accessToken, exportsFolderId, `session_${session.sessionId}.docx`);
        if (docxFileId) await deleteDriveFile(accessToken, docxFileId);
      }
    }
  }

  const flatSessionId = await findFile(accessToken, folderId, `session_${session.sessionId}.json`);
  const flatDocxId = await findFile(accessToken, folderId, `session_${session.sessionId}.docx`);
  if (flatSessionId) await deleteDriveFile(accessToken, flatSessionId);
  if (flatDocxId) await deleteDriveFile(accessToken, flatDocxId);
}

export async function deletePatientFromDrive(accessToken: string, patientId: string) {
  const folderId = await ensureAppFolder(accessToken);
  const patientsFolderId = await findFile(accessToken, folderId, "patients");
  if (!patientsFolderId) return;
  const patientFolderId = await findFile(accessToken, patientsFolderId, `patient_${patientId}`);
  if (patientFolderId) await deleteDriveFile(accessToken, patientFolderId);
}

export async function loadTherapyDataFromDrive(accessToken: string): Promise<{
  patients: Patient[];
  sessions: TherapySession[];
}> {
  const folderId = await ensureAppFolder(accessToken);
  const patientsFolderId = await findFile(accessToken, folderId, "patients");
  const patientsIndex = await downloadJsonFile<{ patients?: Array<{ patientId: string; displayName: string }> }>(
    accessToken,
    folderId,
    "patients_index.json"
  );
  const sessionsIndex = await downloadJsonFile<TherapySession[]>(accessToken, folderId, "sessions_index.json");

  const sessions = Array.isArray(sessionsIndex) ? sessionsIndex : [];
  const drivePatients = patientsFolderId ? await loadPatientsFromFolders(accessToken, patientsFolderId) : [];
  const patientRows = Array.isArray(patientsIndex?.patients) ? patientsIndex.patients : [];
  const now = new Date().toISOString();
  const indexedPatients = patientRows.map((patient) => ({
    patientId: patient.patientId,
    ownerUserId: "google-drive",
    displayName: patient.displayName,
    optionalDetails: {
      fullName: "",
      phone: "",
      age: "",
      treatmentStatus: "",
      generalNotes: ""
    },
    createdAt: now,
    updatedAt: now
  }));
  const patients = mergeDrivePatients(drivePatients, indexedPatients);

  return { patients, sessions };
}

async function waitForGoogleIdentity() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Google Identity Services לא נטען בדפדפן");
}

function requestAccessToken() {
  return new Promise<string>((resolve, reject) => {
    const tokenClient = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID!,
      scope: GOOGLE_SCOPES,
      prompt: "consent",
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || "לא התקבל access token מגוגל"));
          return;
        }
        resolve(response.access_token);
      }
    });

    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

async function signInWithNativeGoogle(): Promise<{ user: UserProfile; accessToken: string }> {
  const result = await window.Capacitor!.Plugins!.NativeGoogleAuth!.signIn({
    scopes: GOOGLE_SCOPES.split(" ")
  });
  if (!result.accessToken) throw new Error("לא התקבל access token מ-Google באנדרואיד");

  const profile = result.email
    ? {
        sub: result.userId || result.email,
        email: result.email,
        name: result.displayName || result.email
      }
    : await fetchGoogleProfile(result.accessToken);

  const user: UserProfile = {
    userId: profile.sub,
    email: profile.email,
    displayName: profile.name || profile.email,
    createdAt: new Date().toISOString(),
    settings: {
      defaultLanguage: "he",
      saveAudioAfterProcessing: false,
      exportFormat: "docx"
    }
  };

  sessionStorage.setItem("therapy:google-access-token", result.accessToken);
  return { user, accessToken: result.accessToken };
}

function isNativeGoogleAuthAvailable() {
  return Boolean(
    window.Capacitor?.isNativePlatform?.() &&
      window.Capacitor?.Plugins?.NativeGoogleAuth?.signIn
  );
}

async function fetchGoogleProfile(accessToken: string): Promise<{ sub: string; email: string; name: string }> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error("לא הצלחנו לקרוא פרופיל Google");
  return response.json();
}

async function ensureAppFolder(accessToken: string) {
  const query = encodeURIComponent(
    `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const existing = await driveFetch(accessToken, `/drive/v3/files?q=${query}&fields=files(id,name)`);
  if (existing.files?.[0]?.id) return existing.files[0].id as string;

  const created = await driveFetch(accessToken, "/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: APP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    })
  });
  return created.id as string;
}

async function ensureChildFolder(accessToken: string, parentId: string, name: string) {
  const safeName = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const existing = await driveFetch(accessToken, `/drive/v3/files?q=${query}&fields=files(id,name)`);
  if (existing.files?.[0]?.id) return existing.files[0].id as string;

  const created = await driveFetch(accessToken, "/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    })
  });
  return created.id as string;
}

async function uploadJsonFile(accessToken: string, folderId: string, fileName: string, data: unknown) {
  await uploadBlobFile(accessToken, folderId, fileName, "application/json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}

async function uploadBlobFile(accessToken: string, folderId: string, fileName: string, mimeType: string, blob: Blob) {
  const existing = await findFile(accessToken, folderId, fileName);
  const metadata = {
    name: fileName,
    mimeType,
    parents: existing ? undefined : [folderId]
  };
  const body = new FormData();
  body.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.set("file", blob);

  const path = existing
    ? `/upload/drive/v3/files/${existing}?uploadType=multipart`
    : "/upload/drive/v3/files?uploadType=multipart";
  await driveFetch(accessToken, path, {
    method: existing ? "PATCH" : "POST",
    body
  });
}

async function downloadJsonFile<T>(accessToken: string, folderId: string, fileName: string): Promise<T | null> {
  const fileId = await findFile(accessToken, folderId, fileName);
  if (!fileId) return null;

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`שגיאת קריאה מ-Google Drive: ${response.status} ${text.slice(0, 240)}`);
  }

  return response.json() as Promise<T>;
}

async function loadPatientsFromFolders(accessToken: string, patientsFolderId: string) {
  const query = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and '${patientsFolderId}' in parents and trashed=false`
  );
  const folders = await driveFetch(accessToken, `/drive/v3/files?q=${query}&fields=files(id,name)`);
  const patients: Patient[] = [];

  for (const folder of folders.files || []) {
    const patient = await downloadJsonFile<Patient>(accessToken, folder.id, "patient.json");
    if (patient?.patientId) patients.push(patient);
  }

  return patients;
}

function mergeDrivePatients(primary: Patient[], fallback: Patient[]) {
  const map = new Map<string, Patient>();
  [...fallback, ...primary].forEach((patient) => map.set(patient.patientId, patient));
  return Array.from(map.values());
}

async function findFile(accessToken: string, folderId: string, fileName: string) {
  const safeName = fileName.replace(/'/g, "\\'");
  const query = encodeURIComponent(`name='${safeName}' and '${folderId}' in parents and trashed=false`);
  const result = await driveFetch(accessToken, `/drive/v3/files?q=${query}&fields=files(id,name)`);
  return result.files?.[0]?.id as string | undefined;
}

async function deleteDriveFile(accessToken: string, fileId: string) {
  await driveFetch(accessToken, `/drive/v3/files/${fileId}`, { method: "DELETE" });
}

async function driveFetch(accessToken: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`שגיאת Google Drive: ${response.status} ${text.slice(0, 240)}`);
  }

  return response.status === 204 ? {} : response.json();
}

function buildPatientsIndex(patients: Patient[], sessions: TherapySession[]) {
  return {
    patients: patients.map((patient) => {
      const patientSessions = sessions.filter((session) => session.patientId === patient.patientId);
      const lastSessionDate = patientSessions
        .map((session) => session.sessionDate)
        .sort()
        .at(-1);
      return {
        patientId: patient.patientId,
        displayName: patient.displayName,
        lastSessionDate: lastSessionDate || "",
        sessionCount: patientSessions.length
      };
    }),
    sessionsByDate: sessions.reduce<Record<string, Array<{ sessionId: string; patientId: string; patientDisplayName: string }>>>(
      (accumulator, session) => {
        accumulator[session.sessionDate] ||= [];
        accumulator[session.sessionDate].push({
          sessionId: session.sessionId,
          patientId: session.patientId,
          patientDisplayName: session.patientDisplayName
        });
        return accumulator;
      },
      {}
    )
  };
}
