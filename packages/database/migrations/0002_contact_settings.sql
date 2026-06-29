CREATE TABLE IF NOT EXISTS Contact_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Recovery_Email TEXT NOT NULL DEFAULT '',
  Contact_Email TEXT NOT NULL DEFAULT '',
  Contact_Phone TEXT NOT NULL DEFAULT '',
  Updated_At TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO Contact_Settings (ID) VALUES (1);
