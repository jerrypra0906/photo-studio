-- Google → app: events created directly in Google Calendar wait here until someone turns them into a booking
-- or ignores them. Personal events share the studio calendar, so nothing becomes a booking automatically.
CREATE TABLE gcal_inbox (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id    text NOT NULL UNIQUE,
  summary     text NOT NULL DEFAULT '',
  description text,
  location    text,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'IGNORED')),
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON gcal_inbox (status, start_at);

ALTER TABLE settings ADD COLUMN gcal_pulled_at timestamptz, ADD COLUMN gcal_pull_error text;
