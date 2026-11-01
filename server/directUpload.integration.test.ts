import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

test("direct upload verifies size, completes once, and joins live transcripts in order", async () => {
  const originalFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, string>();
  let transcriptions = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const report = {
    meetingTopic: "מפגש בדיקה", sessionNarrative: "תיאור מפגש בדיקה בלבד. ".repeat(60),
    therapeuticInsights: "התערבות שתועדה בבדיקה. ".repeat(40), followUpPoints: ["א", "ב", "ג", "ד"],
    administrativeNotes: "", crmSummary: "בדיקה", internalSessionMemory: {}
  };
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.GCS_BUCKET = "test-bucket";
  process.env.GOOGLE_CLOUD_CLIENT_EMAIL = "test@example.invalid";
  process.env.GOOGLE_CLOUD_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  process.env.PROCESSING_MODE = "hybrid";
  globalThis.fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address);
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fake-token", expires_in: 3600 });
    if (url.hostname === "api.openai.com") {
      if (url.pathname.endsWith("/audio/transcriptions")) { transcriptions++; return new Response("תמלול בדיקה בעברית. ".repeat(10), { headers: { "content-type": "text/plain" } }); }
      return json({ id: "test", choices: [{ message: { role: "assistant", content: JSON.stringify(report) }, finish_reason: "stop" }] });
    }
    assert.equal(url.hostname, "storage.googleapis.com", "tests must not use external services");
    if (url.pathname === "/resumable-test") {
      const name = uploads.get(url.searchParams.get("id")!)!;
      objects.set(name, Buffer.from(init?.body as ArrayBuffer));
      return json({ size: objects.get(name)!.length });
    }
    if (url.searchParams.get("uploadType") === "resumable") {
      const id = String(uploads.size);
      uploads.set(id, url.searchParams.get("name")!);
      return new Response(null, { status: 200, headers: { location: `https://storage.googleapis.com/resumable-test?id=${id}` } });
    }
    if (url.searchParams.get("uploadType") === "media") {
      objects.set(url.searchParams.get("name")!, Buffer.from(init?.body as Uint8Array));
      return json({});
    }
    const name = decodeURIComponent(url.pathname.split("/o/")[1] || "");
    if (init?.method === "DELETE") { objects.delete(name); return json({}); }
    if (!objects.has(name)) return json({ error: "missing" }, 404);
    if (url.searchParams.get("fields") === "size") return json({ size: String(objects.get(name)!.length) });
    return new Response(new Uint8Array(objects.get(name)!));
  };
  let server: import("node:http").Server | undefined;
  try {
    ({ httpServer: server } = await import("./index"));
    if (!server.listening) await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const post = (route: string, value: unknown) => originalFetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const session = { sessionId: "test-session", patientDisplayName: "בדיקה", sessionType: "טיפול" };
    const start = async (transcriptOnly: boolean) => {
      const response = await post("/api/process-session-upload", { session, fileName: "test.m4a", mimeType: "audio/mp4", size: 4, transport: "resumable", transcriptOnly });
      assert.equal(response.status, 202);
      return response.json() as Promise<{ jobId: string; uploadUrl: string }>;
    };
    const finish = async (jobId: string) => {
      for (let i = 0; i < 100; i++) {
        const status = await (await originalFetch(base + "/api/process-session-job/" + jobId)).json() as any;
        if (status.status === "completed") return status;
        if (status.status === "failed") assert.fail(status.message);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("job did not complete");
    };
    const one = await start(true);
    assert.equal((await post(`/api/process-session-upload/${one.jobId}/complete`, {})).status, 409);
    assert.equal(transcriptions, 0);
    await globalThis.fetch(one.uploadUrl, { method: "PUT", body: new Uint8Array([1, 2, 3, 4]).buffer });
    assert.equal((await post(`/api/process-session-upload/${one.jobId}/complete`, {})).status, 202);
    await finish(one.jobId);
    assert.equal((await post(`/api/process-session-upload/${one.jobId}/complete`, {})).status, 202);
    assert.equal(transcriptions, 1);
    const two = await start(true);
    await globalThis.fetch(two.uploadUrl, { method: "PUT", body: new Uint8Array([1, 2, 3, 4]).buffer });
    await post(`/api/process-session-upload/${two.jobId}/complete`, {});
    await finish(two.jobId);
    const rejected = await post("/api/process-live-report", { session: { sessionId: "other-session" }, segmentJobIds: [one.jobId] });
    assert.equal(rejected.status, 400);
    const parent = await (await post("/api/process-live-report", { session, segmentJobIds: [one.jobId, two.jobId] })).json() as { jobId: string };
    const result = await finish(parent.jobId);
    assert.equal(result.result.report.meetingTopic, "מפגש בדיקה");
    assert.equal(transcriptions, 2, "final report must reuse existing transcripts");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
