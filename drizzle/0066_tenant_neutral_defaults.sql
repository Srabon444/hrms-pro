ALTER TABLE "tenant_settings" ALTER COLUMN "currency" SET DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "timezone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "fiscal_year_start_month" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "weekend_days" SET DEFAULT '{0,6}'::smallint[];