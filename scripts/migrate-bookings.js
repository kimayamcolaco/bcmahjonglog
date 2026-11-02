const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { validBooking } = require("../api/bookings");

function validate(bookings) {
  if (!Array.isArray(bookings) || !bookings.every(validBooking)) {
    throw new Error("Backup must be an array of complete bookings. No missing dates or credentials will be invented.");
  }
  const ids = new Set();
  const seats = new Set();
  for (const booking of bookings) {
    const seat = JSON.stringify([booking.date, booking.slot, booking.table, booking.seat]);
    if (ids.has(booking.id) || seats.has(seat)) {
      throw new Error("Backup contains duplicate booking IDs or occupied seats; resolve these before migration.");
    }
    ids.add(booking.id);
    seats.add(seat);
  }
}

async function main(args) {
  const command = args.shift();
  const apply = args.includes("--apply");
  const option = name => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  if (command === "backup") {
    const source = option("--source");
    const output = option("--out");
    if (!source || !output) throw new Error("Usage: node scripts\\migrate-bookings.js backup --source <booking API URL> --out <JSON file>");
    const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
    const headers = bypass ? { "x-vercel-protection-bypass": bypass } : {};
    const response = await fetch(source, { cache: "no-store", headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Backup read failed: HTTP ${response.status}`);
    const bookings = await response.json();
    validate(bookings);
    const text = JSON.stringify(bookings, null, 2) + "\n";
    await fs.writeFile(output, text, { flag: "wx", mode: 0o600 });
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    await fs.writeFile(`${output}.sha256`, `${digest}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Backed up ${bookings.length} bookings to ${output}. SHA-256: ${digest}`);
    return;
  }
  if (command !== "migrate" || !option("--file")) {
    throw new Error("Usage: node scripts\\migrate-bookings.js migrate --file <backup JSON> [--apply]");
  }
  const file = option("--file");
  const text = await fs.readFile(file, "utf8");
  const expectedDigest = (await fs.readFile(`${file}.sha256`, "utf8")).trim();
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  if (digest !== expectedDigest) throw new Error("Backup checksum mismatch. The file changed; do not migrate it.");
  const bookings = JSON.parse(text);
  validate(bookings);
  console.log(`Validated ${bookings.length} bookings (${Buffer.byteLength(text)} backup bytes).`);
  if (!apply) {
    console.log("Dry run only. No database requests made. Add --apply only after following MIGRATION.md.");
    return;
  }
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key.startsWith("sb_secret_")) throw new Error("Set SUPABASE_URL and a new sb_secret_ key as SUPABASE_SECRET_KEY in your local environment; never paste them into source files.");
  const headers = { apikey: key, "Content-Type": "application/json" };
  async function request(path, options = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Supabase migration request failed: HTTP ${response.status}. Check the table schema and server key; existing rows were not overwritten.`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async function readAll() {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await request(`mahjong_bookings?select=id,data&order=id.asc&limit=500&offset=${offset}`);
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  }
  const existing = new Map((await readAll()).map(row => [row.id, row.data]));
  for (const booking of bookings) {
    if (existing.has(booking.id) && !isDeepStrictEqual(existing.get(booking.id), booking)) {
      throw new Error("A destination booking differs from the backup. Stop and reconcile the cutover; no rows were overwritten.");
    }
  }
  const missing = bookings.filter(booking => !existing.has(booking.id));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100);
    await request("mahjong_bookings?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(batch.map(data => ({ id: data.id, booking_date: data.date, data })))
    });
    console.log(`Inserted batch ${Math.floor(offset / 100) + 1}; existing IDs were left unchanged.`);
  }
  const migrated = new Map((await readAll()).map(row => [row.id, row.data]));
  if (bookings.some(booking => !isDeepStrictEqual(migrated.get(booking.id), booking))) {
    throw new Error("Migration verification failed. Keep the old deployment and backup; do not cut over.");
  }
  console.log(`Verified all ${bookings.length} source bookings, including IDs, dates, groups, and cancellation credentials. KVDB was not changed.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, validate };
