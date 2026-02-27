-- Kids Kermesse: Registrations table
-- Run this in your Supabase SQL editor

CREATE TABLE registrations (
  id           UUID PRIMARY KEY,               -- Unique ID, also encoded in the QR
  name         TEXT NOT NULL,                  -- Parent / guardian name
  student_name TEXT NOT NULL,                  -- Student name
  email        TEXT NOT NULL,                  -- Contact email
  checked_in   BOOLEAN DEFAULT FALSE,          -- For door scanning (future)
  checked_in_at TIMESTAMP WITH TIME ZONE,      -- Timestamp of check-in (future)
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Optional: prevent duplicate emails
CREATE UNIQUE INDEX registrations_email_unique ON registrations(email);

-- Row Level Security (recommended)
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;

-- Only your backend (service key) can read/write
-- No public access
CREATE POLICY "Service role only" ON registrations
  USING (auth.role() = 'service_role');
