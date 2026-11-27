CREATE TABLE "kiosk_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"site_id" uuid NOT NULL,
	"token_hash" text,
	"pair_hash" text,
	"pair_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"ip_cidrs" "cidr"[] DEFAULT '{}'::cidr[] NOT NULL,
	CONSTRAINT "kiosk_devices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "kiosk_devices_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "kiosk_devices_name_ck" CHECK (length(trim("kiosk_devices"."name")) between 1 and 60),
	CONSTRAINT "kiosk_devices_hash_ck" CHECK (("kiosk_devices"."token_hash" is null or "kiosk_devices"."token_hash" ~ '^[0-9a-f]{64}$') and ("kiosk_devices"."pair_hash" is null or "kiosk_devices"."pair_hash" ~ '^[0-9a-f]{64}$') and ("kiosk_devices"."pair_hash" is null) = ("kiosk_devices"."pair_expires_at" is null)),
	CONSTRAINT "kiosk_devices_ips_ck" CHECK (cardinality("kiosk_devices"."ip_cidrs") <= 20)
);
--> statement-breakpoint
ALTER TABLE "attendance_punches" DROP CONSTRAINT "attendance_punches_source_ck";--> statement-breakpoint
ALTER TABLE "member_secrets" ALTER COLUMN "pdf_password_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_secrets" ADD COLUMN "kiosk_pin_mac" text;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."work_sites"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_devices_token_uq" ON "kiosk_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_devices_pair_uq" ON "kiosk_devices" USING btree ("pair_hash");--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_source_ck" CHECK ("attendance_punches"."source" in ('web','manual','device','regularization','kiosk'));--> statement-breakpoint
ALTER TABLE "member_secrets" ADD CONSTRAINT "member_secrets_any_ck" CHECK ("member_secrets"."pdf_password_enc" is not null or "member_secrets"."kiosk_pin_mac" is not null);