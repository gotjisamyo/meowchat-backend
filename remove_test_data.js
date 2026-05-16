const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:AxdUFNOnLEOSKgZJqavwbTcXCCKRCXen@caboose.proxy.rlwy.net:34672/railway'
});

async function run() {
  await client.connect();
  console.log("Connected.");
  
  // Begin transaction
  await client.query('BEGIN');

  try {
    // Let's identify the test users
    const testUsers = await client.query(`
      SELECT id, email FROM users 
      WHERE email LIKE 'test_%' 
         OR email LIKE 'trial_%' 
         OR email LIKE 'trial%@test.com'
         OR email LIKE '%@meowchat.test'
         OR email LIKE 'omise_test@%'
    `);
    
    console.log("Found", testUsers.rowCount, "test users.");

    if (testUsers.rowCount > 0) {
      const userIds = testUsers.rows.map(u => u.id);
      
      // Delete their shops
      const shopRes = await client.query(`DELETE FROM shops WHERE user_id = ANY($1::int[]) RETURNING id`, [userIds]);
      console.log(`Deleted ${shopRes.rowCount} test shops.`);

      // Finally delete the users
      const userRes = await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
      console.log(`Deleted ${userRes.rowCount} test users.`);
    }

    // Also delete any orphan shops (testing directly on shops, e.g. name = 'test...')
    const orphanShops = await client.query(`
      DELETE FROM shops WHERE name LIKE 'test_%' OR name LIKE 'Test %'
      RETURNING id
    `);
    console.log(`Deleted ${orphanShops.rowCount} test shops directly.`);

    await client.query('COMMIT');
    console.log("Clean up successful!");
  } catch (e) {
    await client.query('ROLLBACK');
    console.error("Error during cleanup:", e);
  } finally {
    await client.end();
  }
}

run();
