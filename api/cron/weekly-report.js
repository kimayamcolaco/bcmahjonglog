const crypto = require('crypto');

module.exports = async (req, res) => {
  // Simple auth check to ensure only Vercel Crons or authorized admins trigger this
  const authHeader = req.headers['authorization'];
  const isCron = req.headers['x-vercel-cron'] === 'true';
  const isLocal = process.env.NODE_ENV === 'development';
  const hasSecret = req.query.secret === process.env.CRON_SECRET;

  if (!isCron && !isLocal && !hasSecret && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized access." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;

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
    const upsertBody = {
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
      body: JSON.stringify(upsertBody)
    });

    if (!upsertRes.ok) {
      throw new Error(`Failed to save weekly stats: ${upsertRes.statusText}`);
    }

    // 4. Send email report to kimayamcolaco@gmail.com via Resend API
    let emailSent = false;
    let emailError = null;

    if (resendApiKey) {
      const setSaturationPercent = Math.round((slotsWithSetsFull / 12) * 100);
      
      let dailyBreakdownHtml = "";
      dayNames.forEach(d => {
        dailyBreakdownHtml += `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">${d}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${dailyBookings[d]} bookings</td>
          </tr>
        `;
      });

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #0c4a30; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
          <div style="background-color: #0c4a30; padding: 20px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 22px; letter-spacing: 0.5px;">🀄 Bangalore Club Mahjong Log</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.85;">Weekly Summary Report</p>
          </div>
          <div style="padding: 24px; background-color: #faf9f5; color: #2c3531;">
            <h2 style="margin-top: 0; font-size: 16px; color: #b3863b; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px;">Week of ${weekLabel}</h2>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0;">
              <div style="background: white; padding: 15px; border-radius: 6px; border: 1px solid rgba(12,74,48,0.1); text-align: center;">
                <span style="font-size: 12px; color: #6b7770; font-weight: bold; text-transform: uppercase;">Total Active Bookings</span>
                <div style="font-size: 28px; font-weight: bold; color: #0c4a30; margin-top: 5px;">${totalBookings}</div>
              </div>
              <div style="background: white; padding: 15px; border-radius: 6px; border: 1px solid rgba(12,74,48,0.1); text-align: center;">
                <span style="font-size: 12px; color: #6b7770; font-weight: bold; text-transform: uppercase;">Unique Members</span>
                <div style="font-size: 28px; font-weight: bold; color: #b3863b; margin-top: 5px;">${uniquePlayers}</div>
              </div>
            </div>

            <div style="background: white; padding: 15px; border-radius: 6px; border: 1px solid rgba(12,74,48,0.1); margin-bottom: 20px; text-align: center;">
              <span style="font-size: 12px; color: #6b7770; font-weight: bold; text-transform: uppercase;">Club Set Saturation</span>
              <div style="font-size: 20px; font-weight: bold; color: #0c4a30; margin-top: 5px;">${slotsWithSetsFull} / 12 Sessions (${setSaturationPercent}%)</div>
              <p style="margin: 4px 0 0 0; font-size: 11px; color: #6b7770;">Number of sessions where all 4 club sets were fully occupied.</p>
            </div>

            <h3 style="font-size: 14px; margin-bottom: 8px; color: #0c4a30;">Daily Booking Distribution</h3>
            <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 6px; overflow: hidden; border: 1px solid rgba(12,74,48,0.1);">
              <tbody>
                ${dailyBreakdownHtml}
              </tbody>
            </table>

            <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #e5e5e5; text-align: center; font-size: 12px; color: #6b7770;">
              This report was generated automatically. View full trends at <a href="https://bcmahjonglog.vercel.app/dashboard" style="color: #0c4a30; font-weight: bold; text-decoration: none;">Admins Dashboard</a>.
            </div>
          </div>
        </div>
      `;

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Bangalore Club Mahjong <onboarding@resend.dev>",
          to: "kimayamcolaco@gmail.com",
          subject: `Bangalore Club Mahjong Log - Weekly Report (${prevMondayStr})`,
          html: emailHtml
        })
      });

      if (resendRes.ok) {
        emailSent = true;
      } else {
        const errJson = await resendRes.json();
        emailError = errJson.message || resendRes.statusText;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Weekly report generated for week ${prevMondayStr} to ${prevSaturdayStr}.`,
      data: upsertBody,
      emailSent,
      emailError
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
