-- Automatically recover fingerprint reservations abandoned by a closed browser
-- or interrupted device session. Existing pending rows are given a short grace
-- period so a deployment does not immediately discard an in-progress flow.
ALTER TABLE device_fingerprint_enrollments ADD COLUMN pending_expires_at TEXT;

UPDATE device_fingerprint_enrollments
SET pending_expires_at = datetime('now', '+2 minutes')
WHERE enrollment_pending = 1 AND pending_expires_at IS NULL;
