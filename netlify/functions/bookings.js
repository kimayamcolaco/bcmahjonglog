const https = require('https');

exports.handler = async function (event, context) {
  const url = "https://kvdb.io/SvmeRCjC2rgQ5SvPj5n7y7/bookings";
  
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
              "Access-Control-Allow-Headers": "Content-Type",
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
              "Access-Control-Allow-Headers": "Content-Type",
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
      req.write(event.body || '');
      req.end();
    });
  }

  return {
    statusCode: 405,
    body: "Method Not Allowed"
  };
};
