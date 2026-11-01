export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;

  async function worker() {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }

  // Drain active operations before callers clean up the files they are reading.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
  return results;
}
