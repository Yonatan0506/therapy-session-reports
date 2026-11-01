import { uploadRequest } from "./uploadRequest";

export function acknowledgedOffset(range: string | null, total: number) {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid upload acknowledgement");
  return offset;
}

export async function sendResumableAudio(file: Blob, uploadUrl: string, onProgress?: (percent: number) => void) {
  if (new URL(uploadUrl).origin !== "https://storage.googleapis.com") throw new Error("Invalid upload destination");
  let offset = 0;
  let failures = 0;
  let probe = true;
  while (offset < file.size) {
    try {
      if (probe) {
        const status = await uploadRequest(uploadUrl, { method: "PUT", credentials: "omit", headers: { "Content-Range": `bytes */${file.size}` }, body: new ArrayBuffer(0) }, { attempts: 1 });
        if (status.status === 200 || status.status === 201) { onProgress?.(100); return; }
        if (status.status !== 308) throw new Error(`Cloud upload status ${status.status}`);
        const acknowledged = acknowledgedOffset(status.headers.get("range"), file.size);
        if (acknowledged > offset) failures = 0;
        offset = acknowledged;
        onProgress?.(Math.round(offset / file.size * 100));
        probe = false;
      }
      const end = Math.min(offset + 4 * 1024 * 1024, file.size);
      if (end <= offset) throw new Error("Cloud upload has not finalized");
      const response = await uploadRequest(uploadUrl, {
        method: "PUT", credentials: "omit",
        headers: { "Content-Type": file.type || "application/octet-stream", "Content-Range": `bytes ${offset}-${end - 1}/${file.size}` },
        body: await file.slice(offset, end).arrayBuffer()
      }, { attempts: 1 });
      if (response.status === 200 || response.status === 201) { onProgress?.(100); return; }
      if (response.status !== 308) throw new Error(`Cloud upload ${response.status}`);
      const next = acknowledgedOffset(response.headers.get("range"), file.size);
      if (next <= offset || next > end) throw new Error("Cloud upload did not acknowledge progress");
      offset = next;
      failures = 0;
      onProgress?.(Math.round(offset / file.size * 100));
    } catch (error) {
      if (++failures >= 5) throw error;
      probe = true;
      await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
    }
  }
}
