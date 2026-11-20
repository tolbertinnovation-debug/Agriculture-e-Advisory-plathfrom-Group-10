// Create the first admin account on a real server (or reset an admin's password).
// Usage: npm run create-admin -- you@example.org "Your Name"
// The password is printed ONCE. Log in, change it, and turn on 2-step login.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "../src/db.js";
import { createStaff, generatePassword, setPassword } from "../src/staff.js";

const [email, ...nameParts] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run create-admin -- you@example.org "Your Name"');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_PATH ?? resolve(here, "../data/agriconnect.db"));
const existing = db.prepare("SELECT id, role FROM staff WHERE email = ?").get(email.trim().toLowerCase());
if (existing) {
  const password = generatePassword();
  setPassword(db, existing.id, password);
  db.prepare("UPDATE staff SET role = 'admin', active = 1 WHERE id = ?").run(existing.id);
  console.log(`Password reset for ${email} (now an active admin).\nNew password: ${password}`);
} else {
  const { staff, password } = createStaff(db, { email, name: nameParts.join(" ") || "Admin", role: "admin", counties: [] });
  console.log(`Admin created: ${staff.email}\nPassword (shown once): ${password}`);
}
console.log("Log in at /prototype/dashboard.html, change the password and turn on 2-step login.");
