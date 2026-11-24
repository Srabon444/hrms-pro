ALTER TABLE "tenant_settings" ADD COLUMN "probation_alert_days" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "document_expiry_alert_days" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "upcoming_hire_days" smallint DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "meal_order_days_ahead" smallint DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "loan_max_instalments" smallint DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "invitation_valid_days" smallint DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "report_share_days" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_probation_alert_days_ck" CHECK ("tenant_settings"."probation_alert_days" between 1 and 180);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_document_expiry_alert_days_ck" CHECK ("tenant_settings"."document_expiry_alert_days" between 1 and 180);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_upcoming_hire_days_ck" CHECK ("tenant_settings"."upcoming_hire_days" between 0 and 90);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_meal_order_days_ahead_ck" CHECK ("tenant_settings"."meal_order_days_ahead" between 1 and 60);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_loan_max_instalments_ck" CHECK ("tenant_settings"."loan_max_instalments" between 1 and 60);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_invitation_valid_days_ck" CHECK ("tenant_settings"."invitation_valid_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_report_share_days_ck" CHECK ("tenant_settings"."report_share_days" between 1 and 90);