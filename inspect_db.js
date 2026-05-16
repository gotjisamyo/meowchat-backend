const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:AxdUFNOnLEOSKgZJqavwbTcXCCKRCXen@caboose.proxy.rlwy.net:34672/railway'
});

async function run() {
  await client.connect();
  console.log("Connected.");
  
  // List columns in shops
  const shopCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'shops';");
  console.log("SHOPS cols:", shopCols.rows.map(r => r.column_name));

  // List columns in users
  const userCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users';");
  console.log("USERS cols:", userCols.rows.map(r => r.column_name));

  // Get some rows
  const shops = await client.query('SELECT * FROM shops LIMIT 5;');
  console.log("SHOPS:", shops.rows);

  const users = await client.query('SELECT * FROM users LIMIT 5;');
  console.log("USERS:", users.rows);

  await client.end();
}

run();
