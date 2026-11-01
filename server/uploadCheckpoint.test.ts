import assert from "node:assert/strict";
import test from "node:test";
import { clearUploadCheckpoint, readUploadCheckpoint, saveUploadCheckpoint, uploadCheckpointKey } from "../src/uploadCheckpoint";

test("checkpoint keys distinguish recording content and session", async () => {
  const first = new File(["first recording"], "audio.m4a");
  const second = new File(["other recording"], "audio.m4a");
  assert.notEqual(await uploadCheckpointKey("session", first), await uploadCheckpointKey("session", second));
  assert.notEqual(await uploadCheckpointKey("session", first), await uploadCheckpointKey("other", first));
  assert.equal(await uploadCheckpointKey("session", first), await uploadCheckpointKey("session", new File(["first recording"], "audio.m4a")));
});

test("only acknowledged, valid, recent progress can be resumed", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } });
  try {
    saveUploadCheckpoint("test", "job", 3);
    assert.equal(readUploadCheckpoint("test", 10)?.nextChunk, 3);
    assert.equal(readUploadCheckpoint("test", 2), null);
    values.set("test", JSON.stringify({ jobId: "job", nextChunk: 3, updatedAt: Date.now() - 3600001 }));
    assert.equal(readUploadCheckpoint("test", 10), null);
    values.set("test", "broken json");
    assert.equal(readUploadCheckpoint("test", 10), null);
    clearUploadCheckpoint("test");
    assert.equal(values.size, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
