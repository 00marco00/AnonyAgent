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
