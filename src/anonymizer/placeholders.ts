import type { EntityType } from "./types.js";

/**
 * Allocates stable placeholders for entity values.
 *
 * - Same original value → same placeholder within a session (referential coherence
 *   matters: if "Marco" appears twice the model should see the same token both times).
 * - Reverse map (placeholder → original) is held in memory only.
 */
export class PlaceholderAllocator {
  private byValue = new Map<string, string>(); // "Marco" -> "[PERSON_1]"
  private byPlaceholder = new Map<string, string>(); // "[PERSON_1]" -> "Marco"
  private counters = new Map<EntityType, number>();

  allocate(type: EntityType, value: string): string {
    const key = `${type}::${this.normalize(value)}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;

    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const placeholder = `[${type}_${n}]`;

    this.byValue.set(key, placeholder);
    this.byPlaceholder.set(placeholder, value);
    return placeholder;
  }

  getOriginal(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  /** Snapshot for UI / debugging. */
  reverseMap(): Map<string, string> {
    return new Map(this.byPlaceholder);
  }

  clear(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.counters.clear();
  }

  /**
   * Two values are considered the same entity if they match case-insensitively
   * and modulo whitespace. Keeps the original on disk; only the key is normalized.
   */
  private normalize(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }
}

/** Regex that matches any placeholder our allocator emits. */
export const PLACEHOLDER_REGEX = /\[[A-Z_]+_\d+\]/g;
