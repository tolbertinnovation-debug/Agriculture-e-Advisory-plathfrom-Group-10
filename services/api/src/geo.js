// Liberia's 15 counties and phone-number helpers.

export const COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh",
  "Grand Kru", "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba",
  "River Cess", "River Gee", "Sinoe"
];

export function findCounty(name) {
  if (typeof name !== "string") return null;
  const n = name.trim().toLowerCase();
  return COUNTIES.find((c) => c.toLowerCase() === n) ?? null;
}

/**
 * Normalise a Liberian mobile number to international format (+231XXXXXXXXX).
 * Accepts "0777 123 456", "777123456", "231777123456", "+231 77 712 3456".
 * Returns null when the input is not a plausible Liberian number.
 */
export function normalizePhone(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;
  let digits = String(input).replace(/[^\d]/g, "");
  if (digits.startsWith("00231")) digits = digits.slice(5);
  else if (digits.startsWith("231")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!/^\d{8,9}$/.test(digits)) return null;
  return "+231" + digits;
}
