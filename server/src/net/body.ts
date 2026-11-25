/** A response as the capped reader needs it; `fetch` and undici both fit. */
export interface MinimalResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  /** Read as a stream when present, so an oversized body is cut off instead of buffered. */
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Reads at most `cap` bytes: a declared Content-Length over the cap is refused before reading,
 * and a stream is cancelled as soon as it passes the cap, so nothing large is ever buffered.
 * `tooLarge` makes the error thrown past the cap.
 */
export async function readCapped(
  response: MinimalResponse,
  cap: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === undefined || response.body === null) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > cap) {
      throw tooLarge();
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
