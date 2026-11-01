export async function uploadRequest(
  url: string,
  init: RequestInit,
  options: { attempts?: number; timeoutMs?: number; retryDelayMs?: number } = {}
): Promise<Response> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 408 && response.status !== 429 && response.status < 500) return response;
      if (attempt === attempts) return response;
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 1000) * attempt));
    }
  }
  throw lastError;
}
