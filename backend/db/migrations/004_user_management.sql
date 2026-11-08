-- User management: soft delete (history keeps the author), login/password timestamps,
-- and an append-only audit trail for admin actions (review: no audit of user/settings changes).
ALTER TABLE users
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN password_changed_at timestamptz;

-- a removed user's email can be registered again
ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_live ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE admin_audit (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,           -- USER_CREATE, USER_UPDATE, USER_DELETE, PASSWORD_CHANGE, PROFILE_UPDATE …
  target_type text NOT NULL,
  target_id   text,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_audit (at);
