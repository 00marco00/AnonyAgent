import { PLACEHOLDER_REGEX } from "./placeholders.js";

/** One-shot de-anonymization on a complete string. */
export function deanonymize(
  text: string,
  reverseMap: Map<string, string>,
): string {
  return text.replace(PLACEHOLDER_REGEX, (m) => reverseMap.get(m) ?? m);
}

/**
 * Streaming de-anonymizer.
 *
 * The LLM emits tokens that may split a placeholder across two chunks
 * (e.g. "[PERS" + "ON_3]"). We buffer the tail until we're sure no
 * partial placeholder is pending, then flush the safe prefix.
 */
export class StreamingDeanonymizer {
  private buffer = "";
  // Longest placeholder we could realistically emit. Keep generous.
  private static MAX_PLACEHOLDER_LEN = 64;

  constructor(private readonly reverseMap: Map<string, string>) {}

  /** Feed a new chunk; returns the safe-to-display prefix. */
  push(chunk: string): string {
    this.buffer += chunk;

    // Find the rightmost '[' that could still be an open placeholder.
    const lastOpen = this.buffer.lastIndexOf("[");
    let safeEnd: number;
    if (lastOpen === -1) {
      safeEnd = this.buffer.length;
    } else {
      const afterOpen = this.buffer.slice(lastOpen);
      const closed = afterOpen.includes("]");
      if (closed) {
        // The last '[' is closed → everything is replaceable now.
        safeEnd = this.buffer.length;
      } else if (afterOpen.length > StreamingDeanonymizer.MAX_PLACEHOLDER_LEN) {
        // Too long to still be a real placeholder; treat as literal.
        safeEnd = this.buffer.length;
      } else {
        // Hold back from the last '[' onward — could still complete.
        safeEnd = lastOpen;
      }
    }

    const ready = this.buffer.slice(0, safeEnd);
    this.buffer = this.buffer.slice(safeEnd);
    return deanonymize(ready, this.reverseMap);
  }

  /** Call once the stream ends; returns whatever remains in the buffer. */
  flush(): string {
    const tail = deanonymize(this.buffer, this.reverseMap);
    this.buffer = "";
    return tail;
  }
}
