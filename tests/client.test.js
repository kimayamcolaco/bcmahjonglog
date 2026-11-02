const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const source = fs.readFileSync(require.resolve("../app.js"), "utf8");
const booking = {
  id: "test-1", date: "2026-11-02", day: "Monday", slot: "Morning",
  table: 1, seat: 1, name: "Test Player", timeStart: "10:00 AM",
  gameType: "Taiwanese", needSet: false, groupId: "test-group"
};

function client(fetch, cacheFails = false) {
  const cache = {};
  const messages = [];
  const context = vm.createContext({
    window: { location: { hostname: "localhost" } },
    document: { addEventListener() {} },
    localStorage: { setItem(k, v) { if (cacheFails) throw new Error("Storage full"); cache[k] = v; } },
    console: { warn() {}, error() {} }, fetch, URLSearchParams,
    TextEncoder, crypto: crypto.webcrypto
  });
  vm.runInContext(source, context);
  context.showToast = (message, type) => messages.push({ message, type });
  return { context, cache, messages };
}

test("one new seat produces a small delta even with 3,473 historical rows", async () => {
  let sent;
  const { context } = client(async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return Response.json({ success: true });
  });
  const previous = Array.from({ length: 3473 }, (_, i) => ({ ...booking, id: `history-${i}` }));
  assert.equal(await context.saveDatabaseBookings(previous.concat(booking), null, previous), true);
  assert.equal(sent.url, "/api/bookings");
  assert.deepEqual(sent.body, { before: [], after: [booking] });
  assert.ok(Buffer.byteLength(JSON.stringify(sent.body)) < 1024);
});

test("failed saves expose the API error and do not cache phantom reservations", async () => {
  const { context, cache, messages } = client(async () => Response.json({ error: "Storage unavailable" }, { status: 502 }));
  assert.equal(await context.saveDatabaseBookings([booking], null, []), false);
  assert.deepEqual(cache, {});
  assert.deepEqual(messages, [{ message: "Storage unavailable", type: "error" }]);
});

test("a successful save is not reported as failed when localStorage is full", async () => {
  const { context, messages } = client(async () => Response.json({ success: true }), true);
  assert.equal(await context.saveDatabaseBookings([booking], null, []), true);
  assert.deepEqual(messages, []);
});

test("cancellation sends only the removed seats and Club ID", async () => {
  let sent;
  const other = { ...booking, id: "other", seat: 2 };
  const { context } = client(async (url, options) => {
    sent = options;
    return Response.json({ success: true });
  });
  assert.equal(await context.saveDatabaseBookings([other], "A123", [booking, other]), true);
  assert.deepEqual(JSON.parse(sent.body), { before: [booking], after: [] });
  assert.equal(sent.headers["X-Cancel-Pin"], "A123");
});

test("active reads use a week filter; exports read full history; failed reads never use cached data", async () => {
  const urls = [];
  const { context } = client(async url => { urls.push(url); return Response.json([]); });
  await context.fetchDatabaseBookings();
  await context.fetchDatabaseBookings(true);
  assert.ok(new URL(urls[0], "http://localhost").searchParams.has("since"));
  assert.equal(new URL(urls[1], "http://localhost").searchParams.has("since"), false);
  context.fetch = async () => Response.json({ error: "Offline" }, { status: 502 });
  await assert.rejects(context.fetchDatabaseBookings(), /Offline/);
});

test("confirm booking failure retains the form and releases the loading overlay", async () => {
  const { context, messages } = client(async (url, options) => options?.method === "POST"
    ? Response.json({ error: "Save failed" }, { status: 502 }) : Response.json([]));
  const values = {
    "modal-table-id": "1", "modal-seat-id": "1", "player-name": "Test Player",
    "player-guests": "0", "player-time-start": "10:00 AM",
    "player-game-type": "Taiwanese", "player-pin": "A123"
  };
  context.document.getElementById = id => ({ value: values[id], checked: false });
  const loading = [];
  let closed = false;
  context.showLoading = value => loading.push(value);
  context.closeBookingModal = () => { closed = true; };
  await context.handleNewBooking();
  assert.equal(closed, false);
  assert.equal(loading.at(-1), false);
  assert.equal(messages.at(-1).message, "Save failed");
});

test("confirm booking saves a complete three-seat group and updates the UI only on success", async () => {
  let payload;
  const { context, cache, messages } = client(async (url, options) => {
    if (options?.method !== "POST") return Response.json([]);
    payload = JSON.parse(options.body);
    return Response.json({ success: true });
  });
  const values = {
    "modal-table-id": "1", "modal-seat-id": "2", "player-name": "Test Player",
    "player-guests": "2", "player-time-start": "10:00 AM",
    "player-game-type": "Taiwanese", "player-pin": "A123"
  };
  context.document.getElementById = id => ({ value: values[id], checked: false });
  let closed = false;
  let updated = false;
  let events;
  const loading = [];
  context.showLoading = value => loading.push(value);
  context.closeBookingModal = () => { closed = true; };
  context.updateView = () => { updated = true; };
  context.logUsageEvents = value => { events = value; };
  await context.handleNewBooking();
  assert.equal(closed, true);
  assert.equal(updated, true);
  assert.equal(loading.at(-1), false);
  assert.deepEqual(payload.before, []);
  assert.equal(payload.after.length, 3);
  assert.equal(new Set(payload.after.map(b => b.seat)).size, 3);
  assert.equal(new Set(payload.after.map(b => b.groupId)).size, 1);
  assert.equal(payload.after[0].pinHash, crypto.createHash("sha256").update("A123").digest("hex"));
  assert.equal(JSON.parse(cache.mahjong_bookings).length, 3);
  assert.equal(events.length, 3);
  assert.match(messages.at(-1).message, /Booked 3 seats/);
});

test("unconfirmed 200 responses cannot cache a reservation", async () => {
  const { context, cache, messages } = client(async () => Response.json({}));
  assert.equal(await context.saveDatabaseBookings([booking], null, []), false);
  assert.deepEqual(cache, {});
  assert.match(messages.at(-1).message, /invalid save confirmation/);
});

test("browser analytics loads the Publishable key and sends it only in apikey", async () => {
  let sent;
  const { context } = client(async (url, options) => {
    if (url === "/api/config") return Response.json({
      supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_test-only"
    });
    sent = { url, options };
    return new Response(null, { status: 201 });
  });
  await context.loadSupabaseConfig();
  await context.logUsageEvents([{ event_type: "booking_created", metadata: { id: booking.id } }]);
  assert.equal(sent.url, "https://example.supabase.co/rest/v1/usage_events");
  assert.equal(sent.options.headers.apikey, "sb_publishable_test-only");
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(sent), /sb_secret_/);
});
