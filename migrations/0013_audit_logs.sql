ALTER TABLE logs ADD COLUMN outcome TEXT;
ALTER TABLE logs ADD COLUMN source TEXT;
ALTER TABLE logs ADD COLUMN details_json TEXT;
ALTER TABLE logs ADD COLUMN command_id TEXT;

CREATE INDEX IF NOT EXISTS idx_logs_timestamp
  ON logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_logs_action_outcome
  ON logs(action, outcome);

CREATE INDEX IF NOT EXISTS idx_logs_command_id
  ON logs(command_id);
