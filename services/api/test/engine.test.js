import { test } from "node:test";
import assert from "node:assert/strict";
import { weeksSincePlanting, stageForWeek, adviceForFarmer, diagnose } from "../src/engine.js";
import { normalizePhone } from "../src/geo.js";
import { content } from "./helpers.js";

const day = (s) => new Date(s + "T08:00:00Z");

test("weeks since planting: planted mid-May, checked early June = week 2", () => {
  assert.equal(weeksSincePlanting(5, day("2026-06-01")), 2);
});

test("weeks since planting: planting coming up next month gives a negative week (preparing)", () => {
  assert.equal(weeksSincePlanting(5, day("2026-04-01")), -7);
});

test("weeks since planting: wraps across the new year", () => {
  // Planted in November 2026, checked in January 2027.
  assert.equal(weeksSincePlanting(11, day("2027-01-20")), 9);
});

test("rice stage for each part of the season", () => {
  const rice = content.crops.get("rice");
  assert.equal(stageForWeek(rice, -3).id, "land-prep");
  assert.equal(stageForWeek(rice, 0).id, "planting");
  assert.equal(stageForWeek(rice, 3).id, "first-weeding");
  assert.equal(stageForWeek(rice, 15).id, "harvest");
  assert.equal(stageForWeek(rice, 40), null);
});

test("advice for a farmer with two crops", () => {
  const farmer = { language: "en", crops: [{ crop: "rice", planting_month: 5 }, { crop: "cassava", planting_month: 4 }] };
  const advice = adviceForFarmer(farmer, content, day("2026-06-05"));
  assert.equal(advice.length, 2);
  assert.equal(advice[0].stage, "first-weeding");
  assert.match(advice[0].message, /^RICE:/);
  assert.equal(advice[1].stage, "early-weeding");
});

test("advice falls back to English when a language has no translation yet", () => {
  const farmer = { language: "kpe", crops: [{ crop: "rice", planting_month: 5 }] };
  const [a] = adviceForFarmer(farmer, content, day("2026-06-05"));
  assert.equal(a.language, "en");
});

test("diagnose: worms + holes = fall armyworm", () => {
  assert.equal(diagnose(["holes", "caterpillar"], content).pest.id, "fall-armyworm");
});

test("diagnose: yellow + twisted on cassava = cassava mosaic", () => {
  assert.equal(diagnose(["yellow", "twisted"], content, "cassava").pest.id, "cassava-mosaic");
});

test("diagnose: brown spots on rice prefers rice blast over cocoa black pod", () => {
  assert.equal(diagnose(["brown"], content, "rice").pest.id, "rice-blast");
});

test("diagnose: no matching symptoms returns null", () => {
  assert.equal(diagnose([], content), null);
});

test("Liberian phone numbers are normalised", () => {
  assert.equal(normalizePhone("0777 123 456"), "+231777123456");
  assert.equal(normalizePhone("+231 88 612 3456"), "+231886123456");
  assert.equal(normalizePhone("231777123456"), "+231777123456");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(undefined), null);
});
