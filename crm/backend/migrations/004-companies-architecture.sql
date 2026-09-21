CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill initial company 'Bagneres'
INSERT INTO companies (name) VALUES ('Bagneres') ON CONFLICT DO NOTHING;

-- Add company_id to brands
ALTER TABLE brands ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

-- Assign existing Studio F brand to Bagneres
UPDATE brands 
SET company_id = (SELECT id FROM companies WHERE name = 'Bagneres' LIMIT 1)
WHERE name = 'Studio F' AND company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_brands_company_id ON brands(company_id);
