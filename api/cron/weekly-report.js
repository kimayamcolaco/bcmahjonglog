const crypto = require('crypto');

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
  // Simple auth check to ensure only Vercel Crons or authorized admins trigger this
  const authHeader = req.headers['authorization'];
  const isCron = req.headers['x-vercel-cron'] === 'true';
  const isLocal = process.env.NODE_ENV === 'development';
  const hasSecret = req.query.secret === process.env.CRON_SECRET;

  if (!isCron && !isLocal && !hasSecret && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized access." });
  }

  const supabaseUrl = sanitizeSupabaseUrl(process.env.SUPABASE_URL);
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Supabase environment variables are missing." });
  }

  try {
    let prevMondayStr = "";
    let prevSaturdayStr = "";
    let weekLabel = "";

    if (req.query.week) {
      // Manually specify the Monday of the week to compile (e.g. ?week=2026-06-08)
      const manualMonday = new Date(req.query.week);
      if (isNaN(manualMonday.getTime())) {
        return res.status(400).json({ error: "Invalid week format. Use YYYY-MM-DD." });
      }
      prevMondayStr = req.query.week;
      const manualSat = new Date(manualMonday.getTime() + (5 * 24 * 60 * 60 * 1000));
      prevSaturdayStr = `${manualSat.getUTCFullYear()}-${String(manualSat.getUTCMonth() + 1).padStart(2, '0')}-${String(manualSat.getUTCDate()).padStart(2, '0')}`;
    } else {
      // Auto-calculate for Sunday morning execution (completed week just finished)
      const nowUtc = new Date();
      const istTime = new Date(nowUtc.getTime() + (5.5 * 60 * 60 * 1000));
      
      const prevMonday = new Date(istTime.getTime() - (6 * 24 * 60 * 60 * 1000));
      prevMondayStr = `${prevMonday.getUTCFullYear()}-${String(prevMonday.getUTCMonth() + 1).padStart(2, '0')}-${String(prevMonday.getUTCDate()).padStart(2, '0')}`;
      
      const prevSaturday = new Date(istTime.getTime() - (1 * 24 * 60 * 60 * 1000));
      prevSaturdayStr = `${prevSaturday.getUTCFullYear()}-${String(prevSaturday.getUTCMonth() + 1).padStart(2, '0')}-${String(prevSaturday.getUTCDate()).padStart(2, '0')}`;
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mParts = prevMondayStr.split('-');
    const sParts = prevSaturdayStr.split('-');
    const mDate = new Date(parseInt(mParts[0]), parseInt(mParts[1]) - 1, parseInt(mParts[2]));
    const sDate = new Date(parseInt(sParts[0]), parseInt(sParts[1]) - 1, parseInt(sParts[2]));
    weekLabel = `${monthNames[mDate.getMonth()]} ${mDate.getDate()} - ${monthNames[sDate.getMonth()]} ${sDate.getDate()}, ${sDate.getFullYear()}`;

    // 1. Fetch usage events for that week from Supabase
    // Note: We fetch all events for bookings scheduled in that date range
    const queryUrl = `${supabaseUrl}/rest/v1/usage_events?date=gte.${prevMondayStr}&date=lte.${prevSaturdayStr}&order=created_at.asc`;
    
    const eventsRes = await fetch(queryUrl, {
      method: "GET",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "x-is-dashboard": "true",
        "Content-Type": "application/json"
      }
    });

    if (!eventsRes.ok) {
      throw new Error(`Failed to fetch events from Supabase: ${eventsRes.statusText}`);
    }

    const events = await eventsRes.json();

    // 2. Aggregate stats
    const activeBookings = new Map();
    let totalCancellations = 0;

    events.forEach(evt => {
      const type = (evt.event_type || "").toLowerCase();
      const payload = evt.metadata || evt.payload || evt.details || evt;
      const bookingId = evt.id || payload.id;

      if (type.includes("create") || type.includes("insert") || type === "booking_created") {
        activeBookings.set(bookingId, {
          name: evt.name || payload.name,
          table: evt.table || payload.table,
          slot: evt.slot || payload.slot,
          needSet: evt.needSet === true || evt.needSet === 'true' || payload.needSet === true || payload.needSet === 'true',
          date: evt.date || payload.date,
          day: evt.day || payload.day
        });
      } else if (type.includes("cancel") || type.includes("delete") || type === "booking_cancelled") {
        activeBookings.delete(bookingId);
        totalCancellations++;
      }
    });

    // Compute metrics
    const bookingsList = Array.from(activeBookings.values());
    const totalBookings = bookingsList.length; // Total people/seats filled

    // Compute unique primary members (exclude guest suffixes like (+1))
    const uniquePlayersSet = new Set();
    bookingsList.forEach(b => {
      if (b.name) {
        const primaryName = b.name.split(" (+")[0].trim();
        uniquePlayersSet.add(primaryName);
      }
    });
    const uniquePlayers = uniquePlayersSet.size;

    // Daily breakdown
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dailyBookings = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 };
    bookingsList.forEach(b => {
      if (b.day && dailyBookings[b.day] !== undefined) {
        dailyBookings[b.day]++;
      }
    });

    // Compute Set Saturation (how many slots had all 4 club sets fully in use)
    // 12 slots total: 6 days * 2 slots (Morning, Afternoon)
    let slotsWithSetsFull = 0;
    const slots = ["Morning", "Afternoon"];

    dayNames.forEach(day => {
      slots.forEach(slot => {
        // Find bookings on this day and slot
        const slotBookings = bookingsList.filter(b => b.day === day && b.slot === slot);
        
        // Count how many unique tables requested a set
        const tablesRequestingSet = new Set();
        slotBookings.forEach(b => {
          if (b.needSet) {
            tablesRequestingSet.add(b.table);
          }
        });

        // If 4 or more tables request a set, all 4 club sets are fully in use
        if (tablesRequestingSet.size >= 4) {
          slotsWithSetsFull++;
        }
      });
    });

    // 3. Write summary stats back to Supabase (Upsert)
    const historyUrl = `${supabaseUrl}/rest/v1/weekly_stats_history`;
    const reportData = {
      week_start_date: prevMondayStr,
      total_bookings: totalBookings,
      total_cancellations: totalCancellations,
      unique_players: uniquePlayers,
      slots_with_sets_full: slotsWithSetsFull,
      total_slots_run: 12,
      bookings_by_day: dailyBookings
    };

    const upsertRes = await fetch(historyUrl, {
      method: "POST",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(reportData)
    });

    if (!upsertRes.ok) {
      throw new Error(`Failed to save weekly stats: ${upsertRes.statusText}`);
    }

    return res.status(200).json({
      success: true,
      message: `Weekly statistics written to database for week ${prevMondayStr} to ${prevSaturdayStr}.`,
      data: reportData
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
