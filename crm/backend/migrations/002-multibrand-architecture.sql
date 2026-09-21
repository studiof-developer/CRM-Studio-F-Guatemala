CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'virtual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Associate whatsapp_numbers with a branch
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS user_whatsapp_numbers (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    whatsapp_number_id INTEGER NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, whatsapp_number_id)
);

-- Backfill data for existing setup
INSERT INTO brands (name) VALUES ('Studio F') ON CONFLICT DO NOTHING;

INSERT INTO branches (brand_id, name, type)
SELECT id, 'Sucursal Virtual', 'virtual' FROM brands WHERE name = 'Studio F'
ON CONFLICT DO NOTHING;

UPDATE whatsapp_numbers 
SET branch_id = (
    SELECT b.id FROM branches b
    JOIN brands br ON b.brand_id = br.id
    WHERE br.name = 'Studio F' AND b.name = 'Sucursal Virtual'
)
WHERE branch_id IS NULL;

-- Automatically assign existing whatsapp numbers to all existing valid users
INSERT INTO user_whatsapp_numbers (user_id, whatsapp_number_id)
SELECT u.id, w.id 
FROM users u 
CROSS JOIN whatsapp_numbers w
WHERE u.role IN ('asesor', 'supervisor', 'admin')
ON CONFLICT DO NOTHING;
