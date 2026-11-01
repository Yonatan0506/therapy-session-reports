import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./parallel";

test("overlapping operations respect the limit and preserve audio order", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([30, 5, 10, 1], 2, async (ms, index) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active--;
    return index;
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.equal(maximum, 2);
});

test("failure stops queued work and drains active operations before cleanup", async () => {
  const failure = new Error("transcription failed");
  const started: number[] = [];
  let drained = false;
  await assert.rejects(mapWithConcurrency([0, 1, 2, 3], 2, async (_, index) => {
    started.push(index);
    if (index === 0) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 15));
    drained = true;
    return index;
  }), failure);
  assert.deepEqual(started, [0, 1]);
  assert.equal(drained, true);
});

test("empty input and invalid concurrency are safe", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 0), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], NaN, async (n) => n * 2), [2, 4]);
});
