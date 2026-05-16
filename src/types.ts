export type ProcessingStatus = "draft" | "pending" | "processing" | "completed" | "failed";

export interface Patient {
  patientId: string;
  ownerUserId: string;
  displayName: string;
  optionalDetails: {
    fullName: string;
    phone: string;
    age: string;
    treatmentStatus: string;
    generalNotes: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SessionReport {
  title: "דו״ח סיכום פגישה טיפולית";
  meetingTopic: string;
  sessionNarrative: string;
  therapeuticInsights: string;
  followUpPoints: string[];
  administrativeNotes: string;
  crmSummary: string;
}

export interface InternalSessionMemory {
  factsFromSession: string[];
  aiInterpretations: string[];
  interventions: string[];
  riskOrUncertaintyNotes: string[];
  openQuestionsForNextSession: string[];
}

export interface TherapySession {
  sessionId: string;
  ownerUserId: string;
  patientId: string;
  patientDisplayName: string;
  therapistName: string;
  sessionDate: string;
  sessionStartTime: string;
  sessionType: string;
  participants: string;
  durationMinutes: number | null;
  price: number | null;
  sourceType: "recording" | "upload";
  audioStored: boolean;
  audioFileName?: string;
  audioMimeType?: string;
  processingJobId?: string;
  processingStage?: string;
  processingMessage?: string;
  processingStatus: ProcessingStatus;
  report: SessionReport;
  internalSessionMemory: InternalSessionMemory;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
  settings: {
    defaultLanguage: "he";
    saveAudioAfterProcessing: boolean;
    exportFormat: "docx";
  };
}
