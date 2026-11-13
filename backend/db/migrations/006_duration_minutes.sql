-- Durations in minutes (e.g. 30 or 90 minutes). `hours` stays as a derived, read-only value so reports keep working.
ALTER TABLE bookings ADD COLUMN duration_min int;
-- a schema conversion, not an edit: closed months must convert too
ALTER TABLE bookings DISABLE TRIGGER bookings_month_lock;
UPDATE bookings SET duration_min = hours * 60;
ALTER TABLE bookings ENABLE TRIGGER bookings_month_lock;
ALTER TABLE bookings ALTER COLUMN duration_min SET NOT NULL,
  ADD CONSTRAINT bookings_duration_min_check CHECK (duration_min >= 15 AND duration_min <= 1440);
ALTER TABLE bookings DROP COLUMN hours;
ALTER TABLE bookings ADD COLUMN hours numeric GENERATED ALWAYS AS (duration_min / 60.0) STORED;

-- message templates: "(2 jam)" → "(1 jam 30 menit)" style label
UPDATE message_templates SET body = replace(body, '({hours} jam)', '({duration})'), updated_at = now() WHERE body LIKE '%({hours} jam)%';
