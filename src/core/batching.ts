/**
 * Splits watched parts into request-sized batches and tops up the spare slots
 * of the last batch with catalog parts, round-robin from `cursor`, so the live
 * stock grid refreshes without extra requests.
 */
export function planBatches(
  watched: string[],
  fill: string[],
  cursor: number,
  max = 20,
): { batches: string[][]; nextCursor: number } {
  const unique = [...new Set(watched)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += max) batches.push(unique.slice(i, i + max));
  if (batches.length === 0) batches.push([]);

  const last = batches[batches.length - 1]!;
  const watchedSet = new Set(unique);
  const candidates = fill.filter((p) => !watchedSet.has(p));
  let nextCursor = cursor;
  if (candidates.length === 0) {
    nextCursor = 0;
  } else {
    const take = Math.min(max - last.length, candidates.length);
    const start = cursor % candidates.length;
    for (let i = 0; i < take; i++) last.push(candidates[(start + i) % candidates.length]!);
    if (take > 0) nextCursor = (start + take) % candidates.length;
  }

  return { batches: batches.filter((b) => b.length > 0), nextCursor };
}
