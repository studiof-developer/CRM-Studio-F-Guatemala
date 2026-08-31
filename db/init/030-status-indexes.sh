#!/bin/bash
set -e

# CONCURRENTLY can't run inside a transaction block — psql already sends each
# statement here as its own autocommit command (no explicit BEGIN in this file),
# so this is safe to run against a live, actively-used database without locking
# writes on tickets/customers.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- The most common filter in the app (Cola de Handoff badge, ticket list, Dashboard
-- KPIs/breakdown) has no index today — fine at today's table size, but this is
-- essentially free insurance against it becoming the next thing that needs a
-- production fire drill once the table grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_status_created_at ON tickets (status, created_at DESC);

-- Serves the "resuelto in the last 30 days" pattern used by both the average
-- resolution time KPI and the per-advisor resolved-tickets breakdown.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_status_resolved_at ON tickets (status, resolved_at);

-- Serves "registros esta semana" and the 14-day new-customers chart.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_created_at ON customers (created_at);

-- Partial: only customers actually marked paid need to be found this way, and
-- that's a small fraction of the table — a full index would waste space indexing
-- rows this query never looks for.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_paid_locked ON customers (paid_locked) WHERE paid_locked;

EOSQL
