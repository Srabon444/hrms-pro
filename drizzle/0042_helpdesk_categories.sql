INSERT INTO "ticket_categories" ("tenant_id", "name", "sla_hours", "confidential")
SELECT t."id", c."name", c."sla_hours", c."confidential" FROM "tenants" t
CROSS JOIN (VALUES ('IT support', 24, false), ('HR query', 48, false), ('Payroll', 48, false), ('Facilities', 72, false), ('Grievance', 24, true)) AS c("name", "sla_hours", "confidential")
ON CONFLICT DO NOTHING;
