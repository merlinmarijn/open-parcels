/** A cached file as pruning sees it. */
export interface CachedFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Deletes files older than `maxAge.ms` at `maxAge.now` (when given), then the oldest until the rest fits `maxBytes`.
 * `remove` deletes one file together with whatever belongs to it. Returns how many were removed.
 */
export async function pruneFiles(
  files: readonly CachedFile[],
  limits: {
    readonly maxAge?: { readonly ms: number; readonly now: number };
    readonly maxBytes: number;
  },
  remove: (file: CachedFile) => Promise<void>,
): Promise<number> {
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  for (const file of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const { maxAge } = limits;
    const fresh = maxAge === undefined || maxAge.now - file.mtimeMs <= maxAge.ms;
    if (fresh && total <= limits.maxBytes) {
      break;
    }
    await remove(file);
    total -= file.size;
    removed += 1;
  }
  return removed;
}
