import React from "react";
import { Box, Text, useInput } from "ink";

export interface MultilineInputProps {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  placeholder?: string;
  isActive?: boolean;
}

/**
 * Custom Ink input that supports:
 *  - true multi-line content (paste with \n keeps newlines, lines wrap to box width)
 *  - block cursor rendered inline via inverse video
 *  - history navigation via ↑/↓ (delegated to parent)
 *  - common shortcuts: Home, End, Ctrl-A/E, Ctrl-U (clear), Ctrl-K (kill to eol)
 *  - Backspace / Delete / ←/→
 *
 * `value` and `cursor` are fully controlled by the parent so external updates
 * (history navigation, programmatic clears) compose cleanly.
 */
export function MultilineInput({
  value,
  cursor,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  placeholder = "",
  isActive = true,
}: MultilineInputProps) {
  useInput(
    (char, key) => {
      // Paste of multi-character content (often includes \n).
      // We detect length > 1 to avoid the single-key path mistaking
      // a pasted \r\n for a submit.
      if (char && char.length > 1 && !key.ctrl && !key.meta) {
        const insert = char.replace(/\r\n?/g, "\n");
        onChange(
          value.slice(0, cursor) + insert + value.slice(cursor),
          cursor + insert.length,
        );
        return;
      }

      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.escape) {
        // Ignored here — parent may bind escape (e.g. close a modal). With
        // no modal active in chat, escape is a no-op.
        return;
      }

      if (key.upArrow) {
        onHistoryUp?.();
        return;
      }
      if (key.downArrow) {
        onHistoryDown?.();
        return;
      }
      if (key.leftArrow) {
        onChange(value, Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        onChange(value, Math.min(value.length, cursor + 1));
        return;
      }

      if (key.backspace || (key.delete && cursor > 0 && !key.meta)) {
        if (cursor === 0) return;
        onChange(
          value.slice(0, cursor - 1) + value.slice(cursor),
          cursor - 1,
        );
        return;
      }

      // Ctrl shortcuts.
      if (key.ctrl) {
        switch (char) {
          case "a":
            onChange(value, lineStart(value, cursor));
            return;
          case "e":
            onChange(value, lineEnd(value, cursor));
            return;
          case "u":
            // Clear from start of line to cursor.
            {
              const s = lineStart(value, cursor);
              onChange(value.slice(0, s) + value.slice(cursor), s);
            }
            return;
          case "k":
            // Kill to end of line.
            {
              const e = lineEnd(value, cursor);
              onChange(value.slice(0, cursor) + value.slice(e), cursor);
            }
            return;
          case "w":
            // Delete previous word.
            {
              const s = prevWordStart(value, cursor);
              onChange(value.slice(0, s) + value.slice(cursor), s);
            }
            return;
        }
        return;
      }

      // Plain character.
      if (char && !key.meta) {
        onChange(
          value.slice(0, cursor) + char + value.slice(cursor),
          cursor + char.length,
        );
      }
    },
    { isActive },
  );

  // ── Render ────────────────────────────────────────────────────────────
  if (value.length === 0) {
    return (
      <Box flexGrow={1}>
        <Text>
          <Text inverse> </Text>
          <Text color="gray">{placeholder}</Text>
        </Text>
      </Box>
    );
  }

  const before = value.slice(0, cursor);
  const at = value.charAt(cursor) || " ";
  const after = value.slice(cursor + 1);

  return (
    <Box flexGrow={1}>
      <Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    </Box>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function lineStart(value: string, cursor: number): number {
  const nl = value.lastIndexOf("\n", cursor - 1);
  return nl === -1 ? 0 : nl + 1;
}

function lineEnd(value: string, cursor: number): number {
  const nl = value.indexOf("\n", cursor);
  return nl === -1 ? value.length : nl;
}

function prevWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(value[i - 1] ?? "")) i--;
  return i;
}
