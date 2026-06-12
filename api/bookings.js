const crypto = require('crypto');

function hashSha256(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}

module.exports = async (req, res) => {
  const url = "https://kvdb.io/SvmeRCjC2rgQ5SvPj5n7y7/bookings";

  // Handle CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cancel-Pin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    try {
      const response = await fetch(`${url}?_=${Date.now()}`, {
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      if (response.status === 404) {
        return res.status(200).json([]);
      }
      if (!response.ok) {
        throw new Error(`KVDB fetch failed with status ${response.status}`);
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      // 1. Fetch current database bookings to verify deletions
      let currentBookings = [];
      const currentRes = await fetch(`${url}?_=${Date.now()}`);
      if (currentRes.ok) {
        currentBookings = await currentRes.json();
      }

      // 2. Parse incoming bookings
      const incomingBookings = req.body || [];

      // 3. Detect deleted bookings
      const deletedBookings = currentBookings.filter(
        cb => !incomingBookings.some(ib => ib.id === cb.id)
      );

      // 4. If there are deletions, check cancellation Club ID header (mapped to X-Cancel-Pin)
      if (deletedBookings.length > 0) {
        const cancelPin = req.headers['x-cancel-pin'] || '';
        const cancelPinHash = hashSha256(cancelPin);

        for (const db of deletedBookings) {
          let pinMatches = false;
          if (db.pinHash) {
            pinMatches = (cancelPinHash === db.pinHash);
          } else if (db.pin) {
            pinMatches = (cancelPin === db.pin);
          } else {
            pinMatches = true; // allow legacy bookings without PINs to be deleted
          }

          if (!pinMatches) {
            return res.status(403).json({ error: "Incorrect Club ID! Cancellation denied." });
          }
        }
      }

      // 5. Proceed with updating the database
      const saveRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(incomingBookings)
      });
      if (!saveRes.ok) {
        throw new Error(`KVDB save failed with status ${saveRes.status}`);
      }
      const saveData = await saveRes.json();
      return res.status(200).json(saveData);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end("Method Not Allowed");
};
