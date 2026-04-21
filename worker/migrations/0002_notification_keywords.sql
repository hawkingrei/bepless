ALTER TABLE reviews
ADD COLUMN notification_keywords_json TEXT NOT NULL DEFAULT '[]';
