import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anonymize } from "./pipeline.js";
import { PlaceholderAllocator } from "./placeholders.js";
import { StreamingDeanonymizer, deanonymize } from "./deanonymize.js";

describe("anonymize (regex only)", () => {
  it("replaces emails with stable placeholders", async () => {
    const r = await anonymize("contact me at foo@bar.com or foo@bar.com", {
      skipNER: true,
    });
    assert.equal(r.anonymized, "contact me at [EMAIL_1] or [EMAIL_1]");
    assert.equal(r.reverseMap.get("[EMAIL_1]"), "foo@bar.com");
  });

  it("handles multiple types in one message", async () => {
    const r = await anonymize(
      "key sk-abcdefghijklmnopqrstuv on 192.168.1.1",
      { skipNER: true },
    );
    assert.match(r.anonymized, /\[API_KEY_1\]/);
    assert.match(r.anonymized, /\[IP_1\]/);
  });

  it("rejects credit-card-shaped strings that fail Luhn", async () => {
    const r = await anonymize("not a card: 1234 5678 9012 3456", {
      skipNER: true,
    });
    assert.ok(!r.anonymized.includes("[CREDIT_CARD"));
  });

  it("accepts a valid Luhn credit card", async () => {
    // 4242 4242 4242 4242 is the Stripe test card (valid Luhn).
    const r = await anonymize("card 4242 4242 4242 4242", { skipNER: true });
    assert.match(r.anonymized, /\[CREDIT_CARD_1\]/);
  });

  it("reuses the same placeholder for the same value across calls", async () => {
    const allocator = new PlaceholderAllocator();
    const a = await anonymize("ping foo@bar.com", { skipNER: true, allocator });
    const b = await anonymize("again foo@bar.com", { skipNER: true, allocator });
    const placeholderA = a.anonymized.match(/\[EMAIL_\d+\]/)?.[0];
    const placeholderB = b.anonymized.match(/\[EMAIL_\d+\]/)?.[0];
    assert.equal(placeholderA, placeholderB);
  });
});

describe("anonymize — widened secret detection", () => {
  it("redacts xAI / HuggingFace / GitLab / JWT keys", async () => {
    const r = await anonymize(
      [
        "xai key xai-abcdefghijklmnopqrstuvwxyz12345678",
        "hf token hf_abcdefghijklmnopqrstuvwxyz123456",
        "glpat-abcdefghijklmnopqrst",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ].join(" "),
      { skipNER: true },
    );
    assert.match(r.anonymized, /\[API_KEY_1\]/);
    assert.match(r.anonymized, /\[API_KEY_2\]/);
    assert.match(r.anonymized, /\[API_KEY_3\]/);
    assert.match(r.anonymized, /\[API_KEY_4\]/);
  });

  it("redacts secret-style assignments (env, JSON, Bearer)", async () => {
    const r = await anonymize(
      [
        "API_KEY=Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTA=",
        '"password": "hunter2hunter2hunter2hunter2"',
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      ].join("\n"),
      { skipNER: true },
    );
    // The keyword "password" / "API_KEY" is left visible; only the value is redacted.
    assert.match(r.anonymized, /API_KEY=\[API_KEY_\d+\]/);
    assert.match(r.anonymized, /"password":\s*"\[API_KEY_\d+\]"/);
    assert.match(r.anonymized, /Bearer \[API_KEY_\d+\]/);
  });

  it("does not redact a long lowercase English word", async () => {
    // High length, low entropy, single character class — should NOT match.
    const r = await anonymize(
      "this verylongwordwithoutanydigits should pass through",
      { skipNER: true },
    );
    assert.equal(r.entities.length, 0);
  });
});

describe("anonymize — dictionary-based PERSON detection", () => {
  it("redacts common French and English first names", async () => {
    const r = await anonymize(
      "Hello Marco, ping Sophie and Alexandre about it.",
      { skipNER: true },
    );
    assert.match(r.anonymized, /\[PERSON_1\]/);
    assert.match(r.anonymized, /\[PERSON_2\]/);
    assert.match(r.anonymized, /\[PERSON_3\]/);
  });

  it("redacts hyphenated names by their first component", async () => {
    const r = await anonymize("Cc Jean-Marc and Marie-Claire", {
      skipNER: true,
    });
    assert.match(r.anonymized, /\[PERSON_1\]/);
    assert.match(r.anonymized, /\[PERSON_2\]/);
  });

  it("does not redact capitalized non-names like 'Hello' or 'Thursday'", async () => {
    const r = await anonymize("Hello Thursday is a good day", {
      skipNER: true,
    });
    assert.ok(!r.anonymized.includes("[PERSON"));
  });
});

describe("deanonymize", () => {
  it("restores values from the reverse map", () => {
    const map = new Map([["[PERSON_1]", "Marco"]]);
    assert.equal(deanonymize("hello [PERSON_1]", map), "hello Marco");
  });
});

describe("StreamingDeanonymizer", () => {
  it("buffers a placeholder split across chunks", () => {
    const map = new Map([["[PERSON_1]", "Marco"]]);
    const d = new StreamingDeanonymizer(map);
    const out =
      d.push("hello [PERS") + d.push("ON_1], how are you") + d.flush();
    assert.equal(out, "hello Marco, how are you");
  });

  it("passes through plain text unchanged", () => {
    const d = new StreamingDeanonymizer(new Map());
    assert.equal(d.push("just a message") + d.flush(), "just a message");
  });

  it("flushes a stray opening bracket", () => {
    const d = new StreamingDeanonymizer(new Map());
    const out = d.push("look at [this") + d.flush();
    assert.equal(out, "look at [this");
  });
});
