const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { main, validate } = require("../scripts/migrate-bookings");
const booking = {
  id: "test-1", date: "2026-11-02", day: "Monday", slot: "Morning",
  table: 1, seat: 1, name: "Test Player", timeStart: "10:00 AM",
  gameType: "Taiwanese", needSet: false, groupId: "test-group"
};
async function backup(t, records = [booking]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mahjong-migration-test-"));
  const file = path.join(dir, "test.backup.json");
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.sha256`, { force: true });
    await fs.rmdir(dir);
  });
  t.mock.method(global, "fetch", async () => Response.json(records));
  t.mock.method(console, "log", () => {});
  await main(["backup", "--source", "https://example.test/api/bookings", "--out", file]);
  return file;
}

test("backup is read-only, refuses overwrite, and dry-run migration makes no requests", async t => {
  const file = await backup(t);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), [booking]);
  await assert.rejects(main(["backup", "--source", "https://example.test/api/bookings", "--out", file]), /EEXIST/);
  t.mock.method(global, "fetch", () => { throw new Error("Dry run must not make requests"); });
  await main(["migrate", "--file", file]);
});

test("backup sends a Vercel automation bypass secret only as a header", async t => {
  const oldBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "private-bypass";
  t.after(() => {
    if (oldBypass === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = oldBypass;
  });
  t.mock.method(global, "fetch", async (url, options) => {
    assert.equal(url, "https://example.test/api/bookings");
    assert.equal(options.headers["x-vercel-protection-bypass"], "private-bypass");
    return Response.json([booking]);
  });
  t.mock.method(console, "log", () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mahjong-migration-test-"));
  const file = path.join(dir, "protected.backup.json");
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  await main(["backup", "--source", "https://example.test/api/bookings", "--out", file]);
});

test("modified backups and duplicate seats are rejected before migration", async t => {
  const file = await backup(t);
  await fs.appendFile(file, " ");
  await assert.rejects(main(["migrate", "--file", file]), /checksum/);
  assert.throws(() => validate([booking, { ...booking, id: "other" }]), /duplicate/);
  assert.throws(() => validate([{ ...booking, date: undefined }]), /complete/);
});

test("apply preserves full payloads, writes small batches and verifies every source row", async t => {
  const records = Array.from({ length: 1101 }, (_, i) => ({
    ...booking, id: `row-${String(i).padStart(4, "0")}`,
    date: new Date(Date.UTC(2030, 0, i + 1)).toISOString().slice(0, 10)
  }));
  const file = await backup(t, records);
  const destination = new Map();
  const sizes = [];
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = oldKey;
  });
  t.mock.method(global, "fetch", async (url, options) => {
    assert.match(url, /^https:\/\/example\.supabase\.co\//);
    assert.equal(options.headers.apikey, "sb_secret_test-only");
    assert.equal(options.headers.Authorization, undefined);
    if (options.method === "POST") {
      const rows = JSON.parse(options.body);
      sizes.push(rows.length);
      assert.ok(rows.every(row => row.booking_date === row.data.date));
      for (const row of rows) if (!destination.has(row.id)) destination.set(row.id, row);
      return new Response(null, { status: 201 });
    }
    const offset = Number(new URL(url).searchParams.get("offset"));
    return Response.json([...destination.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(offset, offset + 500));
  });
  await main(["migrate", "--file", file, "--apply"]);
  assert.equal(destination.size, 1101);
  assert.ok(sizes.every(size => size <= 100));
  assert.deepEqual([...destination.values()].map(row => row.data), records);
  const writeCount = sizes.length;
  await main(["migrate", "--file", file, "--apply"]);
  assert.equal(sizes.length, writeCount);
  destination.get(records[0].id).data = { ...records[0], name: "Changed" };
  await assert.rejects(main(["migrate", "--file", file, "--apply"]), /differs/);
  assert.equal(sizes.length, writeCount);
});
