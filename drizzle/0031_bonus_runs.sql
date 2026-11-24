ALTER TABLE "tenant_settings" ADD COLUMN "bonus_rate_bp" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "bonus_min_service_months" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_bonus_ck" CHECK ("tenant_settings"."bonus_rate_bp" between 0 and 50000 and "tenant_settings"."bonus_min_service_months" between 0 and 120);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_title_ck" CHECK (("payroll_runs"."run_type" = 'bonus') = ("payroll_runs"."title" is not null) and ("payroll_runs"."title" is null or length(trim("payroll_runs"."title")) between 1 and 60));