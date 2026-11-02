const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const weeklyReport = require("../api/cron/weekly-report");

test("dashboard fetches events and history with a Publishable apikey, not a bearer JWT", async () => {
  const html = fs.readFileSync(require.resolve("../dashboard.html"), "utf8");
  const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).at(-1)[1];
  const requests = [];
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById() { return { innerText: "", classList: { add() {}, remove() {} } }; } },
    console: { warn() {}, error() {} },
    fetch: async (url, options) => {
      if (url === "/api/config") return Response.json({
        supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_test-only"
      });
      requests.push({ url, options });
      return Response.json([]);
    }
  });
  vm.runInContext(script, context);
  context.processEvents = () => {};
  context.compileWeeksList = () => {};
  context.showSection = () => {};
  vm.runInContext("state.mondayDate = new Date(2026, 10, 2); state.sundayDate = new Date(2026, 10, 8);", context);
  await context.loadSupabaseConfig();
  assert.equal(context.checkConfigured(), true);
  await context.fetchUsageEvents();
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/usage_events\?/);
  assert.match(requests[1].url, /\/weekly_stats_history\?/);
  for (const { options } of requests) {
    assert.equal(options.headers.apikey, "sb_publishable_test-only");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers["x-is-dashboard"], "true");
  }
});

function configureReport(t, secret) {
  const values = {
    NODE_ENV: "development", SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: secret
  };
  for (const [name, value] of Object.entries(values)) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
}

function response() {
  return {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("weekly reports read and write with the Secret apikey, not a bearer JWT", async t => {
  configureReport(t, "sb_secret_test-only");
  const requests = [];
  t.mock.method(global, "fetch", async (url, options) => {
    requests.push({ url, options });
    return options.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
  });
  const res = response();
  await weeklyReport({ headers: {}, query: { week: "2026-11-02" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(requests.length, 2);
  for (const { options } of requests) {
    assert.equal(options.headers.apikey, "sb_secret_test-only");
    assert.equal(options.headers.Authorization, undefined);
  }
  assert.doesNotMatch(JSON.stringify(res.body), /sb_secret_/);
});

test("weekly reports cannot fall back to a public or legacy key", async t => {
  configureReport(t, "sb_publishable_wrong-role");
  t.mock.method(console, "error", () => {});
  t.mock.method(global, "fetch", () => { throw new Error("Wrong key must fail before any database request"); });
  const res = response();
  await weeklyReport({ headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /Secret key/);
});
