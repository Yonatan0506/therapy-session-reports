import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgedOffset, sendResumableAudio } from "../src/resumableUpload";

test("resumable range acknowledgements reject invalid offsets", () => {
  assert.equal(acknowledgedOffset(null, 10), 0);
  assert.equal(acknowledgedOffset("bytes=0-4", 10), 5);
  assert.throws(() => acknowledgedOffset("bytes=0-10", 10));
  assert.throws(() => acknowledgedOffset("broken", 10));
});

test("a lost response resumes from the server offset instead of duplicating bytes", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const ranges: string[] = [];
  globalThis.fetch = async (_, init) => {
    calls++;
    ranges.push(new Headers(init?.headers).get("content-range") || "");
    if (calls === 1) return new Response(null, { status: 308 });
    if (calls === 2) throw new TypeError("connection lost after server accepted bytes");
    if (calls === 3) return new Response(null, { status: 308, headers: { range: "bytes=0-3" } });
    assert.equal((init?.body as ArrayBuffer).byteLength, 6);
    return new Response("{}", { status: 200 });
  };
  try {
    await sendResumableAudio(new Blob(["0123456789"]), "https://storage.googleapis.com/upload/test");
    assert.deepEqual(ranges, ["bytes */10", "bytes 0-9/10", "bytes */10", "bytes 4-9/10"]);
  } finally { globalThis.fetch = original; }
});

test("completed uploads do not upload the file again", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
  try {
    await sendResumableAudio(new Blob(["audio"]), "https://storage.googleapis.com/upload/test");
    assert.equal(calls, 1);
    await assert.rejects(sendResumableAudio(new Blob(["audio"]), "https://example.invalid/upload"));
  } finally { globalThis.fetch = original; }
});
