function sanitizeSupabaseUrl(url) {
  if (!url) return "";
  let clean = url.trim();
  while (clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  if (clean.endsWith("/rest/v1")) {
    clean = clean.slice(0, -8);
  }
  while (clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  return clean;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (!publishableKey.startsWith("sb_publishable_")) {
    console.error("Analytics configuration requires SUPABASE_PUBLISHABLE_KEY.");
    return res.status(503).json({ error: "Analytics configuration is missing a valid publishable key." });
  }

  return res.status(200).json({
    supabaseUrl: sanitizeSupabaseUrl(process.env.SUPABASE_URL),
    supabasePublishableKey: publishableKey
  });
};
