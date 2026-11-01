-- JES Studio Booking — initial schema (PostgreSQL 18)
-- Money: bigint whole rupiah (TD D4). Time: timestamptz UTC, shown in WIB (TD D5).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- users & auth ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  name          text NOT NULL,
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('OWNER','STAFF')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE login_attempts (
  key         text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON login_attempts (key, at);

-- ---------- masters ----------
CREATE TABLE booking_types (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  name                  citext NOT NULL UNIQUE,
  hourly_rate           bigint NOT NULL CHECK (hourly_rate >= 0),
  requires_photographer boolean NOT NULL DEFAULT false,
  min_hours             int NOT NULL DEFAULT 1 CHECK (min_hours >= 1),
  max_hours             int NOT NULL DEFAULT 8 CHECK (max_hours >= min_hours),
  calendar_keyword      text NOT NULL DEFAULT '',
  color_id              text,
  active                boolean NOT NULL DEFAULT true,
  sort_order            int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE photographers (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        citext NOT NULL,
  phone       text,
  email       text,
  default_fee bigint CHECK (default_fee >= 0),
  fee_unit    text NOT NULL DEFAULT 'SESSION' CHECK (fee_unit IN ('SESSION','HOUR')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- name unique among active photographers (L2-3.2.1)
CREATE UNIQUE INDEX photographers_active_name ON photographers (name) WHERE active;

CREATE TABLE addons (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        citext NOT NULL UNIQUE,
  price       bigint NOT NULL CHECK (price >= 0),
  unit        text NOT NULL CHECK (unit IN ('HOUR','BOOKING','PERSON')),
  vendor_fee  bigint CHECK (vendor_fee >= 0),
  vendor_name text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addon_types (
  addon_id uuid NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  type_id  uuid NOT NULL REFERENCES booking_types(id) ON DELETE RESTRICT,
  PRIMARY KEY (addon_id, type_id)
);

CREATE TABLE expense_categories (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  code           text UNIQUE,              -- system categories: PHOTOGRAPHER_FEE, MUA_FEE
  name           citext NOT NULL UNIQUE,
  kind           text NOT NULL CHECK (kind IN ('FIXED','VARIABLE')),
  recurring      boolean NOT NULL DEFAULT false,
  default_amount bigint CHECK (default_amount >= 0),
  active         boolean NOT NULL DEFAULT true,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  studio_name        text NOT NULL DEFAULT 'JES Space Studio',
  studio_phone       text NOT NULL DEFAULT '',
  address            text NOT NULL DEFAULT '',
  maps_url           text NOT NULL DEFAULT '',
  bank_name          text NOT NULL DEFAULT '',
  account_no         text NOT NULL DEFAULT '',
  account_holder     text NOT NULL DEFAULT '',
  open_hours         jsonb NOT NULL,       -- [{open,close,closed}] index 0 = Sunday
  slot_step_min      int NOT NULL DEFAULT 30,
  max_hours          int NOT NULL DEFAULT 8,
  buffer_min         int NOT NULL DEFAULT 0,
  dp_rule_text       text NOT NULL DEFAULT '',
  terms_text         text NOT NULL DEFAULT '',
  revenue_basis      text NOT NULL DEFAULT 'BILLED' CHECK (revenue_basis IN ('BILLED','COLLECTED')),
  gcal_account_email text,
  gcal_calendar_id   text,
  gcal_calendar_name text,
  gcal_refresh_token text,                 -- AES-256-GCM ciphertext
  gcal_status        text NOT NULL DEFAULT 'NOT_CONNECTED' CHECK (gcal_status IN ('NOT_CONNECTED','CONNECTED','RECONNECT_NEEDED')),
  gcal_cancel_mode   text NOT NULL DEFAULT 'DELETE' CHECK (gcal_cancel_mode IN ('DELETE','MARK')),
  gcal_mark_completed boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_templates (
  kind       text PRIMARY KEY CHECK (kind IN ('NEW','BALANCE','RESCHEDULE','CANCEL')),
  body       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- clients & bookings ----------
CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  name            text NOT NULL,
  phone_e164      text UNIQUE,
  last_booking_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_name_lower ON clients (lower(name));

CREATE TABLE booking_counters (
  day  date PRIMARY KEY,
  last int NOT NULL
);

CREATE TABLE bookings (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  booking_no           text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','COMPLETED','CANCELLED')),
  type_id              uuid NOT NULL REFERENCES booking_types(id),
  type_name_snap       text NOT NULL,
  type_keyword_snap    text NOT NULL DEFAULT '',
  rate_snap            bigint NOT NULL,
  hours                int NOT NULL CHECK (hours >= 1),
  start_at             timestamptz NOT NULL,
  end_at               timestamptz NOT NULL,
  block_end_at         timestamptz NOT NULL,          -- end_at + buffer at save time (review C1)
  client_id            uuid NOT NULL REFERENCES clients(id),
  client_name_snap     text NOT NULL,
  client_phone_snap    text,
  photographer_id      uuid REFERENCES photographers(id),
  photographer_name_snap text,
  adjustment           bigint NOT NULL DEFAULT 0,
  adjustment_reason    text,
  dp_amount            bigint NOT NULL DEFAULT 0 CHECK (dp_amount >= 0),
  paid_amount          bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  total                bigint NOT NULL CHECK (total >= 0),
  -- PG18 virtual generated columns
  balance              bigint GENERATED ALWAYS AS (total - paid_amount) VIRTUAL,
  notes                text,
  after_hours_reason   text,
  back_dated           boolean NOT NULL DEFAULT false,
  invoice_rev          int NOT NULL DEFAULT 0,
  invoice_issued       boolean NOT NULL DEFAULT false,
  invoice_sent_at      timestamptz,
  gcal_event_id        text,
  gcal_sync_status     text NOT NULL DEFAULT 'NONE' CHECK (gcal_sync_status IN ('NONE','PENDING','SYNCED','FAILED')),
  gcal_synced_at       timestamptz,
  gcal_last_error      text,
  cancel_reason        text,
  cancel_note          text,
  cancelled_at         timestamptz,
  completed_at         timestamptz,
  version              int NOT NULL DEFAULT 1,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (block_end_at >= end_at),
  CHECK (dp_amount <= total AND paid_amount <= total),
  -- TD D2 / NFR-05: one room, no two live bookings overlap
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    tstzrange(start_at, block_end_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED')
);
CREATE INDEX ON bookings (start_at);
CREATE INDEX ON bookings (client_id);
CREATE INDEX ON bookings (status, end_at);

CREATE TABLE booking_addons (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_id   uuid NOT NULL REFERENCES addons(id),
  name_snap  text NOT NULL,
  unit_snap  text NOT NULL,
  price_snap bigint NOT NULL,
  qty        int NOT NULL CHECK (qty >= 1),
  line_total bigint NOT NULL,
  vendor_fee_snap bigint,
  vendor_name_snap text,
  PRIMARY KEY (booking_id, addon_id)
);

CREATE TABLE booking_history (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL,              -- CREATE, EDIT, CANCEL, COMPLETE, PAYMENT, INVOICE_SENT …
  field       text,
  old_value   text,
  new_value   text,
  invoice_rev int
);
CREATE INDEX ON booking_history (booking_id, changed_at);

CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  user_id     uuid NOT NULL,
  booking_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- expenses ----------
CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  category_id     uuid NOT NULL REFERENCES expense_categories(id),
  amount          bigint CHECK (amount >= 0),   -- NULL allowed only for DRAFT (US-24.5)
  paid_on         date NOT NULL,
  payee           text,
  note            text,
  booking_id      uuid REFERENCES bookings(id),
  photographer_id uuid REFERENCES photographers(id),
  receipt_key     text,
  receipt_mime    text,
  status          text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT','CONFIRMED')),
  source          text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','BOOKING_FEE','RECURRING')),
  recurring_month text,                            -- YYYY-MM for RECURRING drafts
  deleted_at      timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'DRAFT' OR amount IS NOT NULL)
);
CREATE INDEX ON expenses (paid_on) WHERE deleted_at IS NULL;
CREATE INDEX ON expenses (booking_id);
CREATE UNIQUE INDEX expenses_recurring_once ON expenses (category_id, recurring_month) WHERE source = 'RECURRING';

CREATE TABLE expense_audit (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  expense_id  uuid NOT NULL REFERENCES expenses(id),
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL,
  before      jsonb,
  after       jsonb
);

-- ---------- month close (BR-13) ----------
CREATE TABLE month_closes (
  month         text PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  closed        boolean NOT NULL DEFAULT true,
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  reopened_at   timestamptz,
  reopened_by   uuid REFERENCES users(id),
  reopen_reason text
);

CREATE FUNCTION is_month_closed(m text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM month_closes WHERE month = m AND closed)
$$;

CREATE FUNCTION wib_month(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(t AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM')
$$;

-- Checks OLD and NEW month so a row can't be moved into or out of a closed month (review C8).
CREATE FUNCTION enforce_month_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m_old text; m_new text;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    IF TG_OP <> 'INSERT' THEN m_old := wib_month(OLD.start_at); END IF;
    IF TG_OP <> 'DELETE' THEN m_new := wib_month(NEW.start_at); END IF;
    -- calendar sync bookkeeping is always allowed
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['gcal_event_id','gcal_sync_status','gcal_synced_at','gcal_last_error','updated_at','balance'])
                          = (to_jsonb(OLD) - ARRAY['gcal_event_id','gcal_sync_status','gcal_synced_at','gcal_last_error','updated_at','balance']) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN m_old := to_char(OLD.paid_on, 'YYYY-MM'); END IF;
    IF TG_OP <> 'DELETE' THEN m_new := to_char(NEW.paid_on, 'YYYY-MM'); END IF;
  END IF;
  IF (m_old IS NOT NULL AND is_month_closed(m_old)) OR (m_new IS NOT NULL AND is_month_closed(m_new)) THEN
    RAISE EXCEPTION 'MONTH_CLOSED:%', coalesce(m_old, m_new) USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER bookings_month_lock BEFORE INSERT OR UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_month_lock();
CREATE TRIGGER expenses_month_lock BEFORE INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION enforce_month_lock();

-- ---------- calendar outbox (TD D3) ----------
CREATE TABLE sync_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN ('UPSERT','DELETE')),
  attempts     int NOT NULL DEFAULT 0,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  done_at      timestamptz,
  failed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_outbox_pending ON sync_outbox (next_run_at) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('gcal_outbox', NEW.id::text); RETURN NEW; END $$;
CREATE TRIGGER sync_outbox_notify AFTER INSERT ON sync_outbox FOR EACH ROW EXECUTE FUNCTION notify_outbox();

