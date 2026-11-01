import assert from "node:assert/strict";
import test from "node:test";
import { uploadRequest } from "../src/uploadRequest";

test("upload requests retry network errors and transient server errors", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response("{}", { status: calls === 2 ? 503 : 202 });
  };
  try {
    assert.equal((await uploadRequest("https://example.invalid", {}, { retryDelayMs: 1 })).status, 202);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test("permanent errors are returned without retrying", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 400 }); };
  try {
    assert.equal((await uploadRequest("https://example.invalid", {})).status, 400);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("a stalled request times out and retries", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++;
    if (calls === 2) return new Response("{}", { status: 200 });
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
  };
  try {
    assert.equal((await uploadRequest("https://example.invalid", {}, { timeoutMs: 10, retryDelayMs: 1 })).status, 200);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
