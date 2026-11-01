import test from "node:test";
import assert from "node:assert/strict";
import { transitionMetrics } from "./processingMetrics";

test("records wall time, accumulates repeated stages, and leaves progress updates alone", () => {
  const first = transitionMetrics({ durations: {} }, undefined, "transcribing_audio", 1000);
  assert.equal(transitionMetrics(first, "transcribing_audio", "transcribing_audio", 2000), first);
  const second = transitionMetrics(first, "transcribing_audio", "preparing_audio", 4000);
  assert.equal(second.durations.transcribing_audio, 3000);
  const third = transitionMetrics(second, "preparing_audio", "transcribing_audio", 5000);
  const done = transitionMetrics(third, "transcribing_audio", "completed", 9000);
  assert.equal(done.durations.transcribing_audio, 7000);
  assert.equal(done.durations.preparing_audio, 1000);
  assert.deepEqual(first.durations, {});
});
