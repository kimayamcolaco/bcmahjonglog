const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const handler = require("../api/bookings");

const booking = {
  id: "test-1", date: "2026-11-02", day: "Monday", slot: "Morning",
  table: 1, seat: 1, name: "Test Player", timeStart: "10:00 AM",
  gameType: "Taiwanese", needSet: false, groupId: "test-group",
  pinHash: crypto.createHash("sha256").update("A123").digest("hex")
};
const oldUrl = process.env.SUPABASE_URL;
const oldKey = process.env.SUPABASE_SECRET_KEY;
before(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only";
});
after(() => {
  if (oldUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = oldUrl;
  if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = oldKey;
});
async function invoke(body, method = "POST", headers = {}, query = {}) {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ method, headers, query, body }, res);
  return res;
}

test("booking inserts use a server-only Supabase RPC, never KVDB", async t => {
  let sent;
  t.mock.method(global, "fetch", async (url, options) => {
    sent = { url, options };
    return new Response(null, { status: 204 });
  });
  const res = await invoke({ before: [], after: [booking] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(sent.url, "https://example.supabase.co/rest/v1/rpc/apply_mahjong_booking_changes");
  assert.equal(sent.options.headers.apikey, "sb_secret_test-only");
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(sent.options.body), { p_before: [], p_after: [booking] });
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("wrong Club ID prevents cancellation; correct Club ID reaches the atomic RPC", async t => {
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  assert.equal((await invoke({ before: [booking], after: [] }, "POST", { "x-cancel-pin": "B456" })).statusCode, 403);
  assert.equal(calls, 0);
  assert.equal((await invoke({ before: [booking], after: [] }, "POST", { "x-cancel-pin": "A123" })).statusCode, 200);
  assert.equal(calls, 1);
});

test("legacy PIN and PIN-less cancellation behavior is retained", async t => {
  t.mock.method(global, "fetch", async () => new Response(null, { status: 204 }));
  const legacy = { ...booking, pin: "A123" };
  delete legacy.pinHash;
  assert.equal((await invoke({ before: [legacy], after: [] })).statusCode, 403);
  assert.equal((await invoke({ before: [legacy], after: [] }, "POST", { "x-cancel-pin": "A123" })).statusCode, 200);
  delete legacy.pin;
  assert.equal((await invoke({ before: [legacy], after: [] })).statusCode, 200);
});

test("old full-array clients, malformed rows and duplicate IDs fail explicitly", async t => {
  t.mock.method(global, "fetch", () => { throw new Error("Invalid requests must not write"); });
  for (const input of [
    [booking], { before: [], after: [{ ...booking, seat: 5 }] },
    { before: [], after: [booking, booking] }, { before: null, after: [] },
    { before: [], after: [{ ...booking, date: "2026-02-30" }] }
  ]) {
    assert.equal((await invoke(input)).statusCode, 400);
  }
  assert.equal((await invoke(undefined, "GET", {}, { since: "2026-99-01" })).statusCode, 400);
});

test("GET pages beyond 1,000 records and applies the active date filter", async t => {
  const urls = [];
  t.mock.method(global, "fetch", async url => {
    urls.push(new URL(url));
    const offset = Number(urls.at(-1).searchParams.get("offset"));
    const count = offset < 1000 ? 500 : 1;
    return Response.json(Array.from({ length: count }, (_, i) => ({ data: { ...booking, id: `row-${offset + i}` } })));
  });
  const res = await invoke(undefined, "GET", {}, { since: "2026-11-02" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1001);
  assert.deepEqual(urls.map(url => url.searchParams.get("offset")), ["0", "500", "1000"]);
  assert.ok(urls.every(url => url.searchParams.get("booking_date") === "gte.2026-11-02"));
});

test("database conflicts return 409 and upstream failures return 502", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(global, "fetch", async () => Response.json({ code: "23505", message: "Duplicate seat" }, { status: 409 }));
  assert.equal((await invoke({ before: [], after: [booking] })).statusCode, 409);
  t.mock.method(global, "fetch", async () => new Response("Bad Gateway", { status: 502 }));
  const res = await invoke({ before: [], after: [booking] });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /unavailable/);
});

test("missing server configuration fails closed and does not expose keys", async t => {
  t.mock.method(console, "error", () => {});
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    const res = await invoke(undefined, "GET");
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /sb_secret_test-only/);
  } finally {
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only";
  }
});

test("public analytics configuration returns only the URL and Publishable key", async t => {
  const config = require("../api/config");
  const oldPublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test-only";
  t.after(() => {
    if (oldPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = oldPublishableKey;
  });
  const res = { setHeader() {}, status() { return this; }, json(body) { this.body = body; return this; } };
  await config({}, res);
  assert.deepEqual(res.body, {
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: "sb_publishable_test-only"
  });
  assert.doesNotMatch(JSON.stringify(res.body), /sb_secret_|supabaseSecretKey/);
});

test("a Secret key in public configuration is rejected and never echoed", async t => {
  const config = require("../api/config");
  const oldPublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_secret_misconfigured-test";
  t.after(() => {
    if (oldPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = oldPublishableKey;
  });
  t.mock.method(console, "error", () => {});
  const res = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await config({}, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /sb_secret_/);
});

test("the server API rejects a Publishable key in place of its Secret key", async t => {
  process.env.SUPABASE_SECRET_KEY = "sb_publishable_wrong-role";
  t.after(() => { process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only"; });
  t.mock.method(console, "error", () => {});
  t.mock.method(global, "fetch", () => { throw new Error("Must not call Supabase with the wrong key type"); });
  assert.equal((await invoke(undefined, "GET")).statusCode, 503);
});
