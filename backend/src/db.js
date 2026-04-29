const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || undefined,
  port:     process.env.PGPORT     ? parseInt(process.env.PGPORT) : undefined,
  user:     process.env.PGUSER     || undefined,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || undefined,
  connectionString: process.env.PGHOST ? undefined : process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error:', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
