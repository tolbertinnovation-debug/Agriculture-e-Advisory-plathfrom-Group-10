// Loads and checks the advisory content in /content. Agronomists edit those JSON files;
// this module makes sure every message fits in one SMS and every stage is well formed.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SMS_LIMIT = 160;

export function loadContent(dir) {
  // Crops appear in menus in "menu_order" (rice first: it is Liberia's staple).
  const list = readdirSync(join(dir, "crops"))
    .filter((f) => f.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, "crops", file), "utf8")))
    .sort((a, b) => (a.menu_order ?? 99) - (b.menu_order ?? 99) || a.id.localeCompare(b.id));
  const crops = new Map(list.map((c) => [c.id, c]));
  const pestFile = JSON.parse(readFileSync(join(dir, "pests.json"), "utf8"));
  return {
    crops,
    pests: pestFile.pests,
    symptoms: pestFile.symptoms,
    ussdSymptoms: pestFile.ussd_symptoms ?? [],
    reportCrops: pestFile.report_crops ?? []
  };
}

/** Returns a list of human-readable problems. An empty list means the content is valid. */
export function validateContent({ crops, pests, symptoms, ussdSymptoms = [], reportCrops = [] }) {
  const errors = [];
  const tooLong = (where, text) => {
    if (typeof text !== "string" || !text.trim()) errors.push(`${where}: SMS text is missing`);
    else if (text.length > SMS_LIMIT) errors.push(`${where}: SMS is ${text.length} characters (max ${SMS_LIMIT})`);
  };

  for (const [id, crop] of crops) {
    if (!crop.name) errors.push(`crop ${id}: missing name`);
    if (!Array.isArray(crop.stages) || crop.stages.length === 0) {
      errors.push(`crop ${id}: no stages`);
      continue;
    }
    let previousEnd = -Infinity;
    for (const stage of crop.stages) {
      const where = `crop ${id} / stage ${stage.id}`;
      if (!Number.isInteger(stage.from_week) || !Number.isInteger(stage.to_week)) errors.push(`${where}: from_week and to_week must be whole numbers`);
      else {
        if (stage.from_week > stage.to_week) errors.push(`${where}: from_week is after to_week`);
        if (stage.from_week <= previousEnd) errors.push(`${where}: overlaps the previous stage`);
        previousEnd = stage.to_week;
      }
      tooLong(`${where} (en)`, stage.sms?.en);
      for (const [lang, text] of Object.entries(stage.sms ?? {})) if (lang !== "en") tooLong(`${where} (${lang})`, text);
    }
  }

  for (const pest of pests) {
    const where = `pest ${pest.id}`;
    if (!pest.symptoms?.length) errors.push(`${where}: no symptoms`);
    for (const s of pest.symptoms ?? []) if (!symptoms[s]) errors.push(`${where}: unknown symptom code "${s}"`);
    tooLong(`${where} (en)`, pest.sms?.en);
  }

  // USSD menus can show at most 6 options on one screen.
  if (ussdSymptoms.length < 1 || ussdSymptoms.length > 6) errors.push("ussd_symptoms: need 1 to 6 options");
  for (const opt of ussdSymptoms) {
    if (!opt.label) errors.push("ussd_symptoms: an option has no label");
    for (const s of opt.symptoms ?? []) if (!symptoms[s]) errors.push(`ussd_symptoms "${opt.label}": unknown symptom code "${s}"`);
  }
  if (reportCrops.length < 1 || reportCrops.length > 6) errors.push("report_crops: need 1 to 6 options");
  for (const c of reportCrops) if (!c.id || !c.label) errors.push("report_crops: each option needs an id and a label");
  return errors;
}
