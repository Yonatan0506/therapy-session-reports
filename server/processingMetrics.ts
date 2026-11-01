export interface ProcessingMetrics {
  durations: Record<string, number>;
  stageStartedAt?: string;
  completedChunks?: number;
  totalChunks?: number;
}

export function transitionMetrics(current: ProcessingMetrics, previousStage: string | undefined, nextStage: string, now = Date.now()): ProcessingMetrics {
  if (previousStage === nextStage) return current;
  const durations = { ...current.durations };
  if (previousStage && current.stageStartedAt) {
    durations[previousStage] = (durations[previousStage] || 0) + Math.max(0, now - Date.parse(current.stageStartedAt));
  }
  return { ...current, durations, stageStartedAt: new Date(now).toISOString() };
}
