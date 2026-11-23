INSERT INTO "shifts" ("tenant_id", "name", "start_time", "end_time", "is_default")
SELECT "id", 'General', '09:00', '18:00', true FROM "tenants"
ON CONFLICT DO NOTHING;
