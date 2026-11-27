CREATE TABLE "attendance_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"site_id" uuid,
	"serial" text,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "attendance_devices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_devices_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "attendance_devices_name_ck" CHECK (length(trim("attendance_devices"."name")) between 1 and 60),
	CONSTRAINT "attendance_devices_serial_ck" CHECK ("attendance_devices"."serial" is null or length("attendance_devices"."serial") between 1 and 64),
	CONSTRAINT "attendance_devices_key_ck" CHECK ("attendance_devices"."key_hash" ~ '^[0-9a-f]{64}$' and "attendance_devices"."prefix" ~ '^[0-9a-f]{8}$')
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "device_user_id" text;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."work_sites"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_key_uq" ON "attendance_devices" USING btree ("key_hash");--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."attendance_devices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_punches_review_idx" ON "attendance_punches" USING btree ("tenant_id","at") WHERE "attendance_punches"."needs_review";--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_device_user_uq" UNIQUE("tenant_id","device_user_id");--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_device_user_ck" CHECK ("employees"."device_user_id" is null or "employees"."device_user_id" ~ '^[A-Za-z0-9_.-]{1,32}$');