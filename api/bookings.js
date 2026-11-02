const crypto = require("crypto");

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validBooking(b) {
  return b && typeof b === "object" && !Array.isArray(b)
    && typeof b.id === "string" && b.id.length > 0
    && validDate(b.date)
    && ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(b.day)
    && ["Morning", "Afternoon"].includes(b.slot)
    && Number.isInteger(b.table) && b.table >= 1 && b.table <= 9
    && Number.isInteger(b.seat) && b.seat >= 1 && b.seat <= 4
    && typeof b.name === "string" && b.name.trim().length > 0
    && typeof b.timeStart === "string" && b.timeStart.length > 0
    && typeof b.gameType === "string" && b.gameType.length > 0
    && typeof b.groupId === "string" && b.groupId.length > 0
    && typeof b.needSet === "boolean"
    && (b.pinHash === undefined || /^[a-f0-9]{64}$/.test(b.pinHash))
    && (b.pin === undefined || typeof b.pin === "string");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key.startsWith("sb_secret_")) {
    console.error("Booking storage is missing Supabase server configuration.");
    return res.status(503).json({ error: "Booking storage is not configured. Please contact the administrator." });
  }
  const headers = { apikey: key, "Content-Type": "application/json" };

  async function request(path, options = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const detail = await response.json();
      console.error("Supabase booking request failed:", response.status, detail.code, detail.message);
      const conflict = ["23505", "40001", "23514"].includes(detail.code);
      const error = new Error(conflict
        ? "Bookings changed or the selected table is no longer available. Refresh and try again."
        : "Booking storage could not complete the request. Please try again or contact the administrator.");
      error.status = conflict ? 409 : 502;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  try {
    if (req.method === "GET") {
      const since = req.query?.since;
      if (since !== undefined && !validDate(since)) {
        return res.status(400).json({ error: "Invalid date filter." });
      }
      const bookings = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const query = new URLSearchParams({ select: "data", order: "id.asc", limit: String(pageSize), offset: String(offset) });
        if (since) query.set("booking_date", `gte.${since}`);
        const rows = await request(`mahjong_bookings?${query}`);
        bookings.push(...rows.map(row => row.data));
        if (rows.length < pageSize) break;
      }
      return res.status(200).json(bookings);
    }

    const { before, after } = req.body || {};
    if (!Array.isArray(before) || !Array.isArray(after)
      || !before.every(validBooking) || !after.every(validBooking)
      || new Set(before.map(b => b.id)).size !== before.length
      || new Set(after.map(b => b.id)).size !== after.length) {
      return res.status(400).json({ error: "Invalid booking changes. Reload the app before trying again." });
    }

    // Any replacement or deletion of an existing row requires its cancellation credential.
    if (before.length > 0) {
      const pin = req.headers["x-cancel-pin"] || "";
      if (typeof pin !== "string") {
        return res.status(400).json({ error: "Invalid Club ID header." });
      }
      const hash = crypto.createHash("sha256").update(pin).digest("hex");
      for (const booking of before) {
        if ((booking.pinHash && booking.pinHash !== hash)
          || (!booking.pinHash && booking.pin && booking.pin !== pin)) {
          return res.status(403).json({ error: "Incorrect Club ID! Cancellation denied." });
        }
      }
    }

    // The database compares these complete old rows with stored rows before applying any changes.
    await request("rpc/apply_mahjong_booking_changes", {
      method: "POST", body: JSON.stringify({ p_before: before, p_after: after })
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Booking API failed:", error.message);
    return res.status(error.status || 502).json({
      error: error.status ? error.message : "Booking storage is unavailable. Please try again or contact the administrator."
    });
  }
};

module.exports.validBooking = validBooking;
