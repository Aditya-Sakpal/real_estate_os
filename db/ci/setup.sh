#!/usr/bin/env bash
# Builds a throwaway database the way an environment is built: the owner
# role, the two other roles, the extensions (superuser), then every migration
# as the owner. Used by CI; safe on a laptop with a local superuser.
set -euo pipefail
PG="${PGSUPER:-postgres://postgres:postgres@localhost:5432/postgres}"
psql "$PG" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE salesdesk LOGIN PASSWORD 'salesdesk' NOSUPERUSER CREATEDB;
CREATE ROLE salesdesk_app LOGIN PASSWORD 'salesdesk_app';
CREATE ROLE salesdesk_retention LOGIN PASSWORD 'salesdesk_ret';
CREATE DATABASE salesdesk OWNER salesdesk;
SQL
DB="${PG%/*}/salesdesk"
psql "$DB" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION citext; CREATE EXTENSION ltree; CREATE EXTENSION pgcrypto;"
psql "$DB" -q -v pw_app=salesdesk_app -v pw_ret=salesdesk_ret -f db/bootstrap.sql 2>&1 | grep -v 'syntax error at or near ":"' || true
cat > .env.local <<ENV
DATABASE_URL="postgres://salesdesk:salesdesk@localhost:5432/salesdesk"
DATABASE_APP_URL="postgres://salesdesk_app:salesdesk_app@localhost:5432/salesdesk"
DATABASE_RETENTION_URL="postgres://salesdesk_retention:salesdesk_ret@localhost:5432/salesdesk"
AUTH_SECRET="ci-only-secret"
AUTH_URL="http://localhost:3000"
CONNECTOR_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
ENV
npm run db:migrate
