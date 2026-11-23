ALTER TABLE "tenant_settings" ADD COLUMN "arrears_lookback_months" smallint DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD COLUMN "for_period" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_arrears_ck" CHECK ("tenant_settings"."arrears_lookback_months" between 1 and 24);--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_for_period_ck" CHECK ("payslip_lines"."for_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');