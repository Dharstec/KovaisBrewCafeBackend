const { Pool, types } = require('pg');
require('dotenv').config();

// Postgres DATE columns (OID 1082) are parsed into JS Date objects by
// default, which then serialize to JSON with a timezone shift - a plain
// "2026-08-31" DATE can come back as "2026-08-30T18:30:00.000Z" (IST),
// corrupting the date by a day and breaking anything expecting a bare
// YYYY-MM-DD string (e.g. native <input type="date"> binding). Return
// the raw string Postgres sends instead of letting pg convert it.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
    host: process.env.POSTGRESQL_HOST,
    user: process.env.POSTGRESQL_USER,
    database: process.env.POSTGRESQL_DATABASE,
    password: process.env.POSTGRESQL_PASSWORD,
    port: parseInt(process.env.POSTGRESQL_PORT, 10),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

// Test connection
(async () => {
    try {
        const client = await pool.connect();
        console.log('✅  DB connected successfully');
        client.release();
    } catch (err) {
        console.error('❌  DB connection failed:', err.message);
    }
})();

module.exports = pool;
