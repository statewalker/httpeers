/**
 * The request's body, streamed where the runtime can and buffered where it
 * cannot.
 *
 * FIREFOX HAS NO `Request.prototype.body` (checked against 155), so reading
 * `request.body` there yields `undefined` -- and forwarding that sends every
 * POST on with no body at all, silently. Where the property is missing the
 * body is read whole instead; everywhere else it still streams.
 *
 * ONE COPY, ON PURPOSE. Every place that rebuilds a Request to forward it
 * needs this, and a second copy is a second chance to forget it.
 */
export async function bodyOf(
  request: Request,
): Promise<ReadableStream<Uint8Array> | ArrayBuffer | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  if (request.body !== undefined) return request.body;
  const bytes = await request.arrayBuffer();
  return bytes.byteLength === 0 ? null : bytes;
}
