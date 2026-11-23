ALTER TABLE "tenant_settings" ADD COLUMN "pf_employee_rate_bp" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "pf_employer_rate_bp" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "overtime_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "overtime_monthly_hours" smallint DEFAULT 208 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_pf_ck" CHECK ("tenant_settings"."pf_employee_rate_bp" between 0 and 5000 and "tenant_settings"."pf_employer_rate_bp" between 0 and 5000);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_ot_pay_ck" CHECK ("tenant_settings"."overtime_rate_bp" between 0 and 50000 and "tenant_settings"."overtime_monthly_hours" between 1 and 744);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_late_count_ck" CHECK ("tenant_settings"."late_policy_count" between 0 and 31);