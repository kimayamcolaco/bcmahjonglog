const https = require('https');
const crypto = require('crypto');

function hashSha256(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}

exports.handler = async function (event, context) {
  const url = "https://kvdb.io/SvmeRCjC2rgQ5SvPj5n7y7/bookings";
  
  // Handle CORS preflight requests
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Cancel-Pin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      },
      body: ""
    };
  }
  
  if (event.httpMethod === "GET") {
    return new Promise((resolve) => {
      https.get(`${url}?_=${Date.now()}`, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type, X-Cancel-Pin",
              "Content-Type": "application/json"
            },
            body: data
          });
        });
      }).on('error', (e) => {
        resolve({
          statusCode: 500,
          body: JSON.stringify({ error: e.message })
        });
      });
    });
  }
  
  if (event.httpMethod === "POST") {
    // 1. Fetch current database bookings to verify deletions
    const currentBookings = await new Promise((resolve) => {
      https.get(`${url}?_=${Date.now()}`, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data || '[]'));
          } catch {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });

    let incomingBookings;
    try {
      incomingBookings = JSON.parse(event.body || '[]');
    } catch (err) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, X-Cancel-Pin",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ error: "Invalid JSON format" })
      };
    }

    // 2. Detect deleted bookings
    const deletedBookings = currentBookings.filter(cb => !incomingBookings.some(ib => ib.id === cb.id));

    // 3. If there are deletions, check cancellation PIN header
    if (deletedBookings.length > 0) {
      const cancelPin = event.headers['x-cancel-pin'] || event.headers['X-Cancel-Pin'] || '';
      const cancelPinHash = hashSha256(cancelPin);

      for (const db of deletedBookings) {
        let pinMatches = false;
        if (db.pinHash) {
          pinMatches = (cancelPinHash === db.pinHash);
        } else if (db.pin) {
          pinMatches = (cancelPin === db.pin);
        } else {
          pinMatches = true; // allow legacy or seed bookings without PINs to be deleted
        }

        if (!pinMatches) {
          return {
            statusCode: 403,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type, X-Cancel-Pin",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ error: "Incorrect PIN! Cancellation denied." })
          };
        }
      }
    }

    // 4. Proceed with updating the database
    return new Promise((resolve) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type, X-Cancel-Pin",
              "Content-Type": "application/json"
            },
            body: data
          });
        });
      });
      req.on('error', (e) => {
        resolve({
          statusCode: 500,
          body: JSON.stringify({ error: e.message })
        });
      });
      req.write(JSON.stringify(incomingBookings));
      req.end();
    });
  }

  return {
    statusCode: 405,
    body: "Method Not Allowed"
  };
};
