// Content editor (Sprint 5): advice texts are drafted by editors and go live only when an
// agronomist approves them. MVP exit criterion: "All advisories in production are approved by
// an agronomist".
//
// Items: every crop stage SMS ("stage:rice:planting") and every pest reply ("pest:fall-armyworm"),
// in English and the local languages. The live text for an item and language is the newest
// approved version; without one, the text from the content/ files is used and shown as
// "not reviewed". Approving the file text as it is counts as a review.
import { sqlNow } from "./db.js";
import { ValidationError, LANGUAGES } from "./farmers.js";
import { SMS_LIMIT } from "./content.js";

export const TEXT_STATUSES = ["draft", "approved", "rejected", "replaced"];

/** Remember the texts from the content/ files once, so they can always be compared and restored. */
function base(content) {
  if (!content.baseTexts) {
    const texts = new Map();
    for (const [cropId, crop] of content.crops) for (const st of crop.stages) texts.set(`stage:${cropId}:${st.id}`, { ...st.sms });
    for (const p of content.pests) texts.set(`pest:${p.id}`, { ...p.sms });
    Object.defineProperty(content, "baseTexts", { value: texts, enumerable: false });
  }
  return content.baseTexts;
}

/** The object whose .sms holds the live texts for an item, or null. */
function target(content, item) {
  const [kind, a, b] = String(item).split(":");
  if (kind === "stage") return content.crops.get(a)?.stages.find((s) => s.id === b) ?? null;
  if (kind === "pest" && b === undefined) return content.pests.find((p) => p.id === a) ?? null;
  return null;
}

/** Put the newest approved texts into the live content (at start-up, after an approval, and every minute). */
export async function applyApprovedTexts(db, content) {
  const files = base(content);
  const rows = await db.all("SELECT item, lang, text FROM content_texts WHERE status = 'approved' ORDER BY id");
  const live = new Map();
  for (const r of rows) live.set(`${r.item}|${r.lang}`, r.text);
  for (const [item, texts] of files) {
    const t = target(content, item);
    if (!t) continue;
    const sms = { ...texts };
    for (const lang of LANGUAGES) {
      const approved = live.get(`${item}|${lang}`);
      if (approved !== undefined) sms[lang] = approved;
    }
    t.sms = sms;
  }
  return rows.length;
}

function describe(content, item) {
  const [kind, a, b] = item.split(":");
  if (kind === "stage") {
    const crop = content.crops.get(a);
    const stage = crop.stages.find((s) => s.id === b);
    return { kind, crop: a, crop_name: crop.name, stage: b, name: stage.name, weeks: [stage.from_week, stage.to_week], hold_in_rain: !!stage.hold_in_rain };
  }
  const pest = content.pests.find((p) => p.id === a);
  return { kind, pest: a, name: pest.name };
}

/**
 * Every item with, per language: the live text, where it comes from, who approved it, and any
 * draft waiting for review. Plus the review progress for the exit criterion.
 */
export async function listContent(db, content) {
  const files = base(content);
  const rows = await db.all("SELECT * FROM content_texts WHERE status IN ('approved', 'draft') ORDER BY id");
  const approved = new Map();
  const drafts = new Map();
  for (const r of rows) (r.status === "approved" ? approved : drafts).set(`${r.item}|${r.lang}`, r);
  const items = [];
  const progress = { en: { total: 0, approved: 0 }, translations: { total: 0, approved: 0 }, drafts: 0 };
  for (const [item, fileTexts] of files) {
    if (!target(content, item)) continue;
    const langs = {};
    for (const lang of LANGUAGES) {
      const a = approved.get(`${item}|${lang}`);
      const d = drafts.get(`${item}|${lang}`);
      const fileText = fileTexts[lang] ?? null;
      const text = a?.text ?? fileText;
      if (!text && !d) continue; // no text in this language yet
      langs[lang] = {
        text,
        source: a ? "approved" : text ? "file" : "none",
        approved_by: a?.reviewer_name ?? null,
        approved_at: a?.decided_at ?? null,
        draft: d ? { id: d.id, text: d.text, author_name: d.author_name, created_at: d.created_at } : null
      };
      const bucket = lang === "en" ? progress.en : progress.translations;
      if (text) { bucket.total++; if (a) bucket.approved++; }
      if (d) progress.drafts++;
    }
    items.push({ item, ...describe(content, item), langs });
  }
  return { items, progress: { ...progress, all_en_approved: progress.en.total > 0 && progress.en.approved === progress.en.total } };
}

function cleanText(text) {
  const t = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  if (!t) throw new ValidationError(["text: write the SMS"]);
  if (t.length > SMS_LIMIT) throw new ValidationError([`text: ${t.length} characters (max ${SMS_LIMIT} for one SMS)`]);
  return t;
}

function checkItem(content, item, lang) {
  if (!target(content, item)) throw new ValidationError([`item: unknown advice "${item}"`]);
  if (!LANGUAGES.includes(lang)) throw new ValidationError([`lang: one of ${LANGUAGES.join(", ")}`]);
}

/** An editor (or agronomist) proposes a new text. It replaces any earlier draft for the same item and language. */
export async function draftText(db, content, staff, { item, lang = "en", text }) {
  checkItem(content, item, lang);
  const clean = cleanText(text);
  return db.tx(async (t) => {
    await t.run("UPDATE content_texts SET status = 'replaced', decided_at = ? WHERE item = ? AND lang = ? AND status = 'draft'", sqlNow(), item, lang);
    const { id } = await t.get(
      "INSERT INTO content_texts (item, lang, text, status, author_id, author_name, created_at) VALUES (?, ?, ?, 'draft', ?, ?, ?) RETURNING id",
      item, lang, clean, staff?.id ?? null, staff?.name ?? null, sqlNow()
    );
    return t.get("SELECT * FROM content_texts WHERE id = ?", id);
  });
}

/**
 * An agronomist approves or rejects a draft. Nobody approves their own draft: a second person
 * always checks. An approved text goes live at once for new messages.
 */
export async function decideDraft(db, content, staff, id, { approve, note }) {
  const d = await db.get("SELECT * FROM content_texts WHERE id = ?", id);
  if (!d) return null;
  if (d.status !== "draft") throw new ValidationError([`this text is already ${d.status}`]);
  if (approve && staff?.id != null && d.author_id === staff.id) throw new ValidationError(["you wrote this draft: another agronomist must approve it"]);
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 300) || null : null;
  if (!approve && !cleanNote) throw new ValidationError(["note: say what to change, so the editor can fix it"]);
  await db.tx(async (t) => {
    if (approve) await t.run("UPDATE content_texts SET status = 'replaced' WHERE item = ? AND lang = ? AND status = 'approved'", d.item, d.lang);
    await t.run("UPDATE content_texts SET status = ?, reviewer_id = ?, reviewer_name = ?, note = ?, decided_at = ? WHERE id = ?",
      approve ? "approved" : "rejected", staff?.id ?? null, staff?.name ?? null, cleanNote, sqlNow(), id);
  });
  if (approve) await applyApprovedTexts(db, content);
  return db.get("SELECT * FROM content_texts WHERE id = ?", id);
}

/** An agronomist checks the text from the files and approves it unchanged. */
export async function approveAsIs(db, content, staff, { item, lang = "en" }) {
  checkItem(content, item, lang);
  const fileText = base(content).get(item)?.[lang];
  if (!fileText) throw new ValidationError(["there is no text in this language yet: write a draft first"]);
  if (await db.get("SELECT 1 AS x FROM content_texts WHERE item = ? AND lang = ? AND status = 'approved'", item, lang)) {
    throw new ValidationError(["this text is already approved"]);
  }
  const now = sqlNow();
  const { id } = await db.get(
    `INSERT INTO content_texts (item, lang, text, status, author_id, author_name, reviewer_id, reviewer_name, note, created_at, decided_at)
     VALUES (?, ?, ?, 'approved', NULL, 'content file', ?, ?, 'approved as written', ?, ?) RETURNING id`,
    item, lang, fileText, staff?.id ?? null, staff?.name ?? null, now, now
  );
  await applyApprovedTexts(db, content);
  return db.get("SELECT * FROM content_texts WHERE id = ?", id);
}

/** All versions of one item and language, newest first (who wrote, who approved or rejected, and why). */
export async function textHistory(db, item, lang) {
  return db.all("SELECT * FROM content_texts WHERE item = ? AND lang = ? ORDER BY id DESC LIMIT 50", item, lang);
}

/** Put the texts from the content/ files back (used by tests). */
export function restoreFileTexts(content) {
  for (const [item, texts] of base(content)) {
    const t = target(content, item);
    if (t) t.sms = { ...texts };
  }
}
