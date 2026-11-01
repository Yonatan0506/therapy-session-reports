type Transfer = {
  stage: (options: { name: string; data: string; append: boolean }) => Promise<{ path: string }>;
  upload: (options: { path: string; uploadUrl: string; jobId: string; completeUrl: string; mimeType: string }) => Promise<void>;
  status: (options: { jobId: string }) => Promise<{ state: string; percent: number; message?: string }>;
};
const nativePaths = new WeakMap<Blob, string>();
export function registerNativeAudio(blob: Blob, path: string) { nativePaths.set(blob, path); }
export function nativeAudioPath(blob: Blob) { return nativePaths.get(blob); }
export function nativeTransfer(): Transfer | undefined {
  return (window.Capacitor?.Plugins as unknown as { NativeTransfer?: Transfer })?.NativeTransfer;
}

export async function transferInBackground(file: File, jobId: string, uploadUrl: string, completeUrl: string, onProgress?: (percent: number) => void) {
  const plugin = nativeTransfer();
  if (!plugin) throw new Error("Native transfer unavailable");
  const existing = await plugin.status({ jobId });
  if (existing.state === "completed") { onProgress?.(100); return; }
  if (existing.state !== "uploading") {
  let path = nativeAudioPath(file);
  if (!path) {
    for (let offset = 0; offset < file.size; offset += 512 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      const staged = await plugin.stage({ name: `${jobId}.audio`, data: btoa(binary), append: offset > 0 });
      path = staged.path;
    }
  }
  if (!path) throw new Error("Audio file unavailable");
  await plugin.upload({ path, uploadUrl, jobId, completeUrl, mimeType: file.type || "application/octet-stream" });
  }
  for (;;) {
    const status = await plugin.status({ jobId });
    onProgress?.(status.percent);
    if (status.state === "completed") return;
    if (status.state === "failed") throw new Error(status.message || "ההעלאה ברקע נכשלה. אפשר לנסות שוב.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
