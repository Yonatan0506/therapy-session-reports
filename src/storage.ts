import type { Patient, TherapySession, UserProfile } from "./types";

const KEYS = {
  user: "therapy:user",
  patients: "therapy:patients",
  sessions: "therapy:sessions",
  pendingAudio: "therapy:pending-audio"
};

const fallbackUser: UserProfile = {
  userId: "demo-google-sub-id",
  email: "therapist@example.com",
  displayName: "מטפל/ת",
  createdAt: new Date().toISOString(),
  settings: {
    defaultLanguage: "he",
    saveAudioAfterProcessing: false,
    exportFormat: "docx"
  }
};

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const storage = {
  getUser: () => readJson<UserProfile>(KEYS.user, fallbackUser),
  saveUser: (user: UserProfile) => writeJson(KEYS.user, user),
  getPatients: () => readJson<Patient[]>(KEYS.patients, []),
  savePatients: (patients: Patient[]) => writeJson(KEYS.patients, patients),
  getSessions: () => readJson<TherapySession[]>(KEYS.sessions, []),
  saveSessions: (sessions: TherapySession[]) => writeJson(KEYS.sessions, sessions)
};
