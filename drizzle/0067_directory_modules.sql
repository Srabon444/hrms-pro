ALTER TABLE "tenant_settings" ADD COLUMN "modules_enabled" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "modules_disabled" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "show_birthday" boolean DEFAULT false NOT NULL;