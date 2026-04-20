CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    project_id TEXT,
    build_id TEXT,
    invocation_id TEXT,
    uploaded_at_ms INTEGER NOT NULL,
    ingest_body TEXT NOT NULL,
    analysis_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_uploaded_at
ON reviews(uploaded_at_ms DESC, id DESC);
