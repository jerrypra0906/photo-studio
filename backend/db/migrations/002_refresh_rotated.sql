-- Separate rotation from revocation: a just-rotated token gets a short grace (parallel tabs),
-- a revoked one (logout, theft response, deactivated user) never does.
ALTER TABLE refresh_tokens ADD COLUMN rotated_at timestamptz;
