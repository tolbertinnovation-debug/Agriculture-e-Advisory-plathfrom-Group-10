import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContent, SMS_LIMIT } from "../src/content.js";
import { content } from "./helpers.js";

test("all content in /content is valid (every SMS fits in 160 characters)", () => {
  assert.deepEqual(validateContent(content), []);
});

test("rice and cassava are loaded", () => {
  assert.ok(content.crops.has("rice"));
  assert.ok(content.crops.has("cassava"));
});

test("validation catches a message that is too long", () => {
  const bad = structuredClone({ ...content, crops: undefined });
  const crop = structuredClone(content.crops.get("rice"));
  crop.stages[0].sms.en = "x".repeat(SMS_LIMIT + 1);
  const errors = validateContent({ ...bad, crops: new Map([["rice", crop]]) });
  assert.ok(errors.some((e) => e.includes("161 characters")));
});

test("validation catches overlapping stages", () => {
  const crop = structuredClone(content.crops.get("rice"));
  crop.stages[1].from_week = crop.stages[0].to_week; // overlap by one week
  const errors = validateContent({ ...content, crops: new Map([["rice", crop]]) });
  assert.ok(errors.some((e) => e.includes("overlaps")));
});

test("validation catches unknown symptom codes", () => {
  const pests = structuredClone(content.pests);
  pests[0].symptoms.push("glowing");
  const errors = validateContent({ ...content, pests });
  assert.ok(errors.some((e) => e.includes('unknown symptom code "glowing"')));
});
