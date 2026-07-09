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
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_interest VARCHAR(255);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_estimate VARCHAR(100);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action VARCHAR(255);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count SMALLINT DEFAULT 0;

    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER NOT NULL REFERENCES leads(id),
      direction   TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      sender      TEXT DEFAULT 'human',
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_templates (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      subject    VARCHAR(255) NOT NULL,
      html       TEXT NOT NULL,
      type       VARCHAR(50) DEFAULT 'custom',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_sequences (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      list_type  VARCHAR(50) NOT NULL,
      active     BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_sequence_steps (
      id          SERIAL PRIMARY KEY,
      sequence_id INTEGER REFERENCES email_sequences(id) ON DELETE CASCADE,
      template_id INTEGER REFERENCES email_templates(id),
      delay_days  INTEGER NOT NULL DEFAULT 0,
      step_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_sequence_log (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER REFERENCES leads(id),
      sequence_id INTEGER REFERENCES email_sequences(id),
      step_id     INTEGER REFERENCES email_sequence_steps(id),
      sent_at     TIMESTAMPTZ DEFAULT NOW(),
      status      VARCHAR(50) DEFAULT 'sent'
    );

    ALTER TABLE email_sequence_steps ADD COLUMN IF NOT EXISTS send_hour VARCHAR(5) DEFAULT '09:00';

    -- Permite borrar/reemplazar pasos al editar una secuencia, o borrar la secuencia
    -- completa, sin violar la FK cuando ya hay historial de envíos.
    ALTER TABLE email_sequence_log DROP CONSTRAINT IF EXISTS email_sequence_log_step_id_fkey;
    ALTER TABLE email_sequence_log ADD CONSTRAINT email_sequence_log_step_id_fkey
      FOREIGN KEY (step_id) REFERENCES email_sequence_steps(id) ON DELETE CASCADE;
    ALTER TABLE email_sequence_log DROP CONSTRAINT IF EXISTS email_sequence_log_sequence_id_fkey;
    ALTER TABLE email_sequence_log ADD CONSTRAINT email_sequence_log_sequence_id_fkey
      FOREIGN KEY (sequence_id) REFERENCES email_sequences(id) ON DELETE CASCADE;
  `);
}

module.exports = { pool, initDb };
