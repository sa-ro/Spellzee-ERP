-- check-no-external-id-columns.sql
-- CI guard for rule 26 (DD §42): no core table may carry an external-system
-- identifier column. External IDs live only in external_id_map.
--
-- Referenced from packages/db/migrations/0007_external_id_map.sql. Run this
-- after migrations in CI; a non-empty result fails the build.
--
-- Usage: psql "$DATABASE_URL" -f scripts/check-no-external-id-columns.sql -t -A
--        A non-empty result (any row printed) means the check failed.

SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name <> 'external_id_map'
  AND (
    column_name ILIKE '%merithub%'
    OR column_name ILIKE '%telicrm%'
    OR column_name ILIKE '%delicio%'
    OR column_name ILIKE '%freejump%'
    OR column_name ILIKE '%external_id%'
  );
