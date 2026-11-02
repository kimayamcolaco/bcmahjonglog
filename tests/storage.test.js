const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
let db;
const booking = {
  id: "test-1", date: "2026-11-02", day: "Monday", slot: "Morning",
  table: 1, seat: 1, name: "Test Player", timeStart: "10:00 AM",
  gameType: "Taiwanese", needSet: false, groupId: "test-group"
};
before(async () => {
  db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(fs.readFileSync(require.resolve("../bookings.sql"), "utf8"));
});
after(async () => { await db.close(); });
async function apply(before, after) {
  return db.query("SELECT public.apply_mahjong_booking_changes($1::jsonb, $2::jsonb)", [JSON.stringify(before), JSON.stringify(after)]);
}
async function reset() { await db.exec("TRUNCATE public.mahjong_bookings"); }

test("schema is rerunnable without losing rows", async () => {
  await reset();
  await apply([], [booking]);
  await db.exec(fs.readFileSync(require.resolve("../bookings.sql"), "utf8"));
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 1);
});

test("groups insert atomically and a duplicate seat rolls the whole group back", async () => {
  await reset();
  await apply([], [booking]);
  await assert.rejects(apply([], [
    { ...booking, id: "guest-1", seat: 2 },
    { ...booking, id: "guest-2", seat: 1 }
  ]), error => error.code === "23505");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 1);
});

test("stale or forged expected rows cannot delete or replace stored reservations", async () => {
  await reset();
  await apply([], [booking]);
  await assert.rejects(apply([{ ...booking, name: "Forged" }], []), error => error.code === "40001");
  assert.equal((await db.query("SELECT data FROM public.mahjong_bookings")).rows[0].data.name, booking.name);
  await apply([booking], []);
  await assert.rejects(apply([booking], []), error => error.code === "40001");
});

test("invalid table start time and game type fail without altering existing seats", async () => {
  await reset();
  await apply([], [booking]);
  for (const change of [{ timeStart: "11:00 AM" }, { gameType: "ATF" }]) {
    await assert.rejects(apply([], [{ ...booking, id: "guest", seat: 2, ...change }]), error => error.code === "23514");
  }
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 1);
});

test("fifth Club Set is rejected; another seat at an existing set table is allowed", async () => {
  await reset();
  await apply([], Array.from({ length: 4 }, (_, i) => ({ ...booking, id: `set-${i}`, table: i + 1, needSet: true })));
  await assert.rejects(apply([], [{ ...booking, id: "fifth", table: 5, needSet: true }]), error => error.code === "23514");
  await apply([], [{ ...booking, id: "same-table", table: 1, seat: 2, needSet: true }]);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 5);
});

test("stale addition deltas preserve unrelated bookings instead of replacing history", async () => {
  await reset();
  await apply([], [booking]);
  await apply([], [{ ...booking, id: "other", seat: 2 }]);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 2);
});

test("anonymous users cannot read bookings or call the mutation function", async () => {
  await db.exec("SET ROLE anon");
  try {
    await assert.rejects(db.query("SELECT * FROM public.mahjong_bookings"), error => error.code === "42501");
    await assert.rejects(apply([], []), error => error.code === "42501");
  } finally {
    await db.exec("RESET ROLE");
  }
});

test("service role can read reservations and invoke the transaction with RLS enabled", async () => {
  await reset();
  await db.exec("SET ROLE service_role");
  try {
    await apply([], [booking]);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.mahjong_bookings")).rows[0].n, 1);
  } finally {
    await db.exec("RESET ROLE");
  }
});
