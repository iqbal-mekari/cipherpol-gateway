/**
 * Run async tasks over items with a bounded concurrency limit. Preserves input
 * order in the returned array. Used to parallelize per-file persistence (each
 * file's upsert/insert is an independent HTTP round-trip) without overwhelming
 * the Supabase REST API.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let active = 0;

  await new Promise<void>((resolve, reject) => {
    const launch = () => {
      // resolve only when everything is done
      if (active === 0 && cursor >= items.length) return resolve();
      while (active < limit && cursor < items.length) {
        const i = cursor++;
        active++;
        Promise.resolve()
          .then(() => fn(items[i]!, i))
          .then(
            (r) => {
              results[i] = r;
              active--;
              launch();
            },
            (err) => {
              active--;
              reject(err);
            },
          );
      }
    };
    launch();
  });

  return results;
}
