require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id          SERIAL PRIMARY KEY,
      name        TEXT,
      phone       TEXT NOT NULL UNIQUE,
      email       TEXT,
      channel     TEXT DEFAULT 'whatsapp',
      type        TEXT DEFAULT 'Buyer',
      status      TEXT DEFAULT 'New',
      zone        TEXT,
      budget      TEXT,
      bedrooms    TEXT,
      timeline    TEXT,
      financing   TEXT,
      urgency     TEXT,
      source      TEXT,
      owner       TEXT,
      tags        TEXT DEFAULT '[]',
      notes       TEXT,
      ai_active      INTEGER DEFAULT 1,
      lead_notified  BOOLEAN DEFAULT false,
      last_lead_data JSONB DEFAULT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_notified BOOLEAN DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_lead_data JSONB DEFAULT NULL;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline VARCHAR(20) DEFAULT 'agent';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage VARCHAR(50) DEFAULT 'new';
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS nurturing BOOLEAN DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_no_show BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER NOT NULL REFERENCES leads(id),
      direction   TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      sender      TEXT DEFAULT 'human',
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { pool, initDb };
