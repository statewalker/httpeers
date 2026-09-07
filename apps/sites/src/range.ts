/**
 * A single byte range, per RFC 9110 §14.
 *
 * SINGLE RANGES ONLY. A multi-range request needs a `multipart/byteranges`
 * body, which is a meaningful amount of machinery for a case static sites do
 * not produce. Ignoring the header and answering 200 with the whole file is
 * explicitly allowed, and is far better than answering 206 with one of the
 * ranges as though it were all of them.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (header == null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match == null) return undefined;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: the LAST n bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}
