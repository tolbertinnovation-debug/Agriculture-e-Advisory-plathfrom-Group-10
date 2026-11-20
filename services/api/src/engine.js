// The advisory engine: decides which advice a farmer should get this week,
// and suggests the likely pest from a list of symptoms. Rule-based on purpose
// (see blueprint §7): only approved content is ever sent, nothing is generated.

const DAY = 24 * 60 * 60 * 1000;

/**
 * Farmers tell us the month they plant (1-12). We assume mid-month and pick the
 * planting date that makes sense for "today": up to 12 weeks in the future
 * (preparing) or up to 40 weeks in the past (growing / harvesting).
 */
export function plantingDate(plantingMonth, today = new Date()) {
  const year = today.getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => new Date(Date.UTC(y, plantingMonth - 1, 15)));
  const weeksFrom = (d) => Math.floor((today - d) / (7 * DAY));
  // Prefer the most recent planting that is no more than 40 weeks ago, unless one is coming within 12 weeks.
  const upcoming = candidates.find((d) => weeksFrom(d) < 0 && weeksFrom(d) >= -12);
  if (upcoming) return upcoming;
  const past = candidates.filter((d) => weeksFrom(d) >= 0).sort((a, b) => b - a)[0];
  return past;
}

export function weeksSincePlanting(plantingMonth, today = new Date()) {
  return Math.floor((today - plantingDate(plantingMonth, today)) / (7 * DAY));
}

/** The crop stage for a given week, or null when the farmer is between seasons. */
export function stageForWeek(crop, week) {
  return crop.stages.find((s) => week >= s.from_week && week <= s.to_week) ?? null;
}

/**
 * This week's advice for each of a farmer's crops.
 * farmer: { language, crops: [{ crop, planting_month }] }
 */
export function adviceForFarmer(farmer, content, today = new Date()) {
  const lang = farmer.language || "en";
  return farmer.crops.map(({ crop: cropId, planting_month }) => {
    const crop = content.crops.get(cropId);
    if (!crop) return { crop: cropId, stage: null, message: null, reason: "no content for this crop yet" };
    const week = weeksSincePlanting(planting_month, today);
    const stage = stageForWeek(crop, week);
    if (!stage) return { crop: cropId, week, stage: null, message: null, reason: "between seasons" };
    return {
      crop: cropId,
      crop_name: crop.name,
      week,
      stage: stage.id,
      stage_name: stage.name,
      language: stage.sms[lang] ? lang : "en",
      message: stage.sms[lang] ?? stage.sms.en,
      content_status: crop.status
    };
  });
}

/**
 * Suggest the most likely pest. Score = share of matching symptoms, using the
 * larger of the two lists so that ticking everything does not give a high score.
 * When the farmer tells us the crop, pests of that crop get a bonus and pests
 * of other crops are halved, so "brown spots on rice" is not called cocoa black pod.
 */
export function diagnose(symptoms, content, cropHint = null) {
  const picked = [...new Set(symptoms)];
  let best = null;
  for (const pest of content.pests) {
    const hits = pest.symptoms.filter((s) => picked.includes(s)).length;
    if (!hits) continue;
    let score = Math.round((100 * hits) / Math.max(pest.symptoms.length, picked.length));
    if (cropHint) score = pest.crops.includes(cropHint) ? Math.min(100, score + 15) : Math.round(score / 2);
    if (!best || score > best.score) best = { pest, score };
  }
  return best;
}
