import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, toPgParams, sqlNow, sqlDaysAgo, isUniqueViolation, TABLES } from "../src/db.js";
import { cleanFarmerInput, createFarmer, getFarmerByPhone, listFarmers } from "../src/farmers.js";
import { createStaff } from "../src/staff.js";
import { sendSms } from "../src/messaging.js";
import { backupDatabase, importBackup, verifyBackup } from "../src/ops.js";
import { content, newDb, TEST_PG } from "./helpers.js";

const farmer = (phone, county = "Bong") => cleanFarmerInput({ phone, county, consent: true, crops: [{ crop: "rice", planting_month: 5 }] }, content);

test("placeholders and times", () => {
  assert.equal(toPgParams("SELECT * FROM t WHERE a = ? AND b IN (?, ?)"), "SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)");
  assert.equal(toPgParams("SELECT '?' AS q, x FROM t WHERE y = ?"), "SELECT '?' AS q, x FROM t WHERE y = $1");
  assert.equal(sqlNow(new Date("2026-11-20T07:05:09.123Z")), "2026-11-20 07:05:09");
  assert.equal(sqlDaysAgo(1, new Date("2026-11-20T07:05:09Z")), "2026-11-19 07:05:09");
});

test("migrations run once and are recorded", async () => {
  const db = await newDb();
  try {
    assert.deepEqual((await db.all("SELECT version, name FROM schema_migrations")).map((r) => [Number(r.version), r.name]), [[1, "initial schema"]]);
    assert.deepEqual(await migrate(db), [], "running again changes nothing");
    for (const t of TABLES) assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n, 0, t);
  } finally {
    await db.close();
  }
});

test("a failed transaction leaves nothing behind", async () => {
  const db = await newDb();
  try {
    await assert.rejects(db.tx(async (t) => {
      await t.run("INSERT INTO farmers (phone, county, consent_at) VALUES (?, ?, ?)", "+231777000001", "Bong", sqlNow());
      throw new Error("boom");
    }), /boom/);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM farmers")).n, 0);
  } finally {
    await db.close();
  }
});

test("a duplicate phone is reported the same way on both databases", async () => {
  const db = await newDb();
  try {
    await createFarmer(db, farmer("0777000001"));
    const err = await createFarmer(db, farmer("0777000001")).catch((e) => e);
    assert.equal(isUniqueViolation(err), true);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM farmer_crops")).n, 1, "the second farmer's crops were rolled back too");
  } finally {
    await db.close();
  }
});

test("other requests wait while a transaction is open (no mixing)", async () => {
  const db = await newDb();
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const tx = db.tx(async (t) => {
      await t.run("INSERT INTO farmers (phone, county, consent_at) VALUES (?, ?, ?)", "+231777000001", "Bong", sqlNow());
      await gate; // the transaction stays open here
      throw new Error("roll back");
    });
    // Meanwhile another request writes outside the transaction.
    const outside = createFarmer(db, farmer("0777000002"));
    setTimeout(release, 30);
    await assert.rejects(tx);
    await outside;
    assert.deepEqual((await listFarmers(db)).map((f) => f.phone), ["+231777000002"], "only the outside write is kept");
  } finally {
    await db.close();
  }
});

test("backup → restore gives back exactly the same data, with new ids after the old ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agriconnect-db-test-"));
  const db = await newDb();
  const db2 = await newDb();
  try {
    await createFarmer(db, farmer("0777000001"));
    await createFarmer(db, farmer("0777000002", "Lofa"));
    await createStaff(db, { email: "a@test.lr", name: "A", role: "admin", password: "correct-horse-battery" });
    await sendSms(db, { phone: "+231777000001", body: "Hello 'quoted' text, with ? marks", kind: "welcome" });
    const b = await backupDatabase(db, dir);
    assert.equal(b.ok, true);
    assert.equal(b.farmers, 2);

    const counts = await importBackup(db2, b.file);
    assert.equal(counts.farmers, 2);
    assert.equal(counts.farmer_crops, 2);
    assert.equal((await getFarmerByPhone(db2, "0777000002")).county, "Lofa");
    assert.equal((await db2.get("SELECT body FROM message_log")).body, "Hello 'quoted' text, with ? marks");
    const next = await createFarmer(db2, farmer("0777000003"));
    assert.equal(next.id, 3, "ids continue after the restored rows");
  } finally {
    await db.close();
    await db2.close();
  }
});

test("a SQLite database file can be copied into the other database (the move to PostgreSQL)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agriconnect-move-"));
  const file = join(dir, "laptop.db");
  const laptop = await openDb(file);
  await createFarmer(laptop, farmer("0777000001", "Nimba"));
  await createStaff(laptop, { email: "officer@test.lr", name: "O", role: "officer", counties: ["Nimba"], password: "correct-horse-battery" });
  await laptop.close();
  assert.equal((await verifyBackup(file)).ok, true);

  const target = await newDb(); // PostgreSQL when TEST_DATABASE_URL is set
  try {
    const counts = await importBackup(target, file);
    assert.equal(counts.farmers, 1);
    assert.equal(counts.staff, 1);
    const f = await getFarmerByPhone(target, "0777000001");
    assert.equal(f.county, "Nimba");
    assert.deepEqual(f.crops, [{ crop: "rice", planting_month: 5 }]);
  } finally {
    await target.close();
  }
});

test("a damaged backup is refused and changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agriconnect-bad-"));
  const db = await newDb();
  try {
    await createFarmer(db, farmer("0777000001"));
    const bad = join(dir, "agriconnect-bad.jsonl.gz");
    const { writeFileSync } = await import("node:fs");
    const { gzipSync } = await import("node:zlib");
    writeFileSync(bad, gzipSync('{"format":"agriconnect-backup","version":1}\n{"t":"farmers","r":{"id":9,"phone":"+231777000009","county":"Bong","consent_at":"x"}}\n'));
    assert.equal((await verifyBackup(bad)).ok, false, "no end marker = incomplete");
    await assert.rejects(importBackup(db, bad), /incomplete/);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM farmers")).n, 1, "the existing data is untouched");
  } finally {
    await db.close();
  }
});

test(`database in use: ${TEST_PG ? "PostgreSQL" : "SQLite"}`, async () => {
  const db = await newDb();
  try {
    assert.equal(db.dialect, TEST_PG ? "postgres" : "sqlite");
  } finally {
    await db.close();
  }
});
