-- Network Monitor: complete D1 database initialization
-- Execute this file once on a newly created, empty Cloudflare D1 database.
-- This is a complete current schema, not an incremental migration.
-- Cloudflare-managed internal tables such as _cf_KV are intentionally excluded.

PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  webhook_url TEXT NOT NULL,
  http_method TEXT NOT NULL DEFAULT 'POST',
  headers_json TEXT NOT NULL DEFAULT '{}',
  body_template TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 10,
  retry_count INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  target TEXT NOT NULL,
  monitor_type TEXT NOT NULL DEFAULT 'ping',
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  locations_json TEXT NOT NULL DEFAULT '["US","DE","JP"]',
  packets INTEGER NOT NULL DEFAULT 3,
  loss_threshold REAL NOT NULL DEFAULT 50,
  failure_threshold INTEGER NOT NULL DEFAULT 3,
  success_threshold INTEGER NOT NULL DEFAULT 2,
  current_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_checked_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_check_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE heartbeat_devices (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'other' CHECK (device_type IN ('ac', 'switch', 'gateway', 'server', 'other')),
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 60,
  offline_threshold_seconds INTEGER NOT NULL DEFAULT 180,
  current_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (current_status IN ('UNKNOWN', 'UP', 'DOWN')),
  last_heartbeat_at TEXT,
  last_ip TEXT,
  agent_version TEXT,
  metadata_json TEXT,
  last_status_changed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  token_ciphertext TEXT,
  deleted_at TEXT
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE measurements (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  globalping_id TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  measurement_type TEXT NOT NULL DEFAULT 'ping',
  status TEXT NOT NULL DEFAULT 'submitted',
  probes_count INTEGER NOT NULL DEFAULT 0,
  successful_probes INTEGER NOT NULL DEFAULT 0,
  failed_probes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT,
  last_polled_at TEXT,
  error_message TEXT,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);

CREATE TABLE monitor_events (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  current_status TEXT NOT NULL,
  message TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);

CREATE TABLE heartbeat_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  current_status TEXT NOT NULL,
  message TEXT,
  details_json TEXT,
  source_ip TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES heartbeat_devices(id)
);

CREATE TABLE probe_results (
  id TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  country TEXT,
  city TEXT,
  network TEXT,
  asn INTEGER,
  probe_status TEXT NOT NULL,
  latency_min REAL,
  latency_avg REAL,
  latency_max REAL,
  packets_sent INTEGER,
  packets_received INTEGER,
  packets_lost INTEGER,
  packet_loss REAL,
  error_message TEXT,
  raw_output TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (measurement_id) REFERENCES measurements(id) ON DELETE CASCADE
);

CREATE TABLE notification_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  webhook_config_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  response_body TEXT,
  error_message TEXT,
  next_retry_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES monitor_events(id),
  FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id)
);

CREATE TABLE heartbeat_notification_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  webhook_config_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed', 'sent')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  response_body TEXT,
  error_message TEXT,
  next_retry_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES heartbeat_events(id),
  FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id),
  UNIQUE(event_id, webhook_config_id)
);

-- Default global time zone, matching the current application default.
INSERT INTO app_settings (key, value, updated_at)
VALUES ('time_zone', 'Asia/Shanghai', datetime('now'))
ON CONFLICT(key) DO NOTHING;

-- Indexes
CREATE INDEX idx_heartbeat_devices_enabled
  ON heartbeat_devices(enabled);

CREATE INDEX idx_heartbeat_devices_status
  ON heartbeat_devices(current_status);

CREATE INDEX idx_heartbeat_events_device_time
  ON heartbeat_events(device_id, created_at DESC);

CREATE INDEX idx_heartbeat_notification_event
  ON heartbeat_notification_logs(event_id);

CREATE INDEX idx_heartbeat_notification_status
  ON heartbeat_notification_logs(status, next_retry_at);

CREATE INDEX idx_measurements_monitor
  ON measurements(monitor_id, created_at);

CREATE INDEX idx_measurements_status
  ON measurements(status, last_polled_at);

CREATE INDEX idx_events_monitor
  ON monitor_events(monitor_id, created_at);

CREATE INDEX idx_events_type
  ON monitor_events(event_type, created_at);

CREATE INDEX idx_monitors_enabled
  ON monitors(enabled, current_status);

CREATE INDEX idx_monitors_site
  ON monitors(site_id);

CREATE INDEX idx_notification_retry
  ON notification_logs(status, next_retry_at);

CREATE INDEX idx_probe_results_measurement
  ON probe_results(measurement_id);
