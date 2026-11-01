-- Login throttling by account (any IP) and by IP (any account): SEC-A8, SEC-A9.
-- key stays "ip|email"; the parts get their own indexes.
CREATE INDEX login_attempts_email ON login_attempts (split_part(key, '|', 2), at);
CREATE INDEX login_attempts_ip ON login_attempts (split_part(key, '|', 1), at);
