CREATE TABLE "work_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"branch_id" uuid,
	"lat" double precision,
	"lng" double precision,
	"radius_m" integer DEFAULT 200 NOT NULL,
	"ip_cidrs" "cidr"[] DEFAULT '{}'::cidr[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "work_sites_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "work_sites_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "work_sites_name_ck" CHECK (length(trim("work_sites"."name")) between 1 and 60),
	CONSTRAINT "work_sites_point_ck" CHECK (("work_sites"."lat" is null) = ("work_sites"."lng" is null) and ("work_sites"."lat" is null or ("work_sites"."lat" between -90 and 90 and "work_sites"."lng" between -180 and 180))),
	CONSTRAINT "work_sites_radius_ck" CHECK ("work_sites"."radius_m" between 25 and 5000),
	CONSTRAINT "work_sites_ips_ck" CHECK (cardinality("work_sites"."ip_cidrs") <= 20),
	CONSTRAINT "work_sites_rule_ck" CHECK ("work_sites"."lat" is not null or cardinality("work_sites"."ip_cidrs") > 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "punch_location_rule" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD COLUMN "outside_site" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "break_minutes" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "break_paid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sites" ADD CONSTRAINT "work_sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sites" ADD CONSTRAINT "work_sites_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."work_sites"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_punch_rule_ck" CHECK ("tenant_settings"."punch_location_rule" in ('off','flag','block'));--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_kind_ck" CHECK ("attendance_punches"."kind" is null or "attendance_punches"."kind" in ('in','out','break_start','break_end'));--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_point_ck" CHECK (("attendance_punches"."lat" is null) = ("attendance_punches"."lng" is null) and ("attendance_punches"."lat" is null) = ("attendance_punches"."accuracy_m" is null) and ("attendance_punches"."lat" is null or ("attendance_punches"."lat" between -90 and 90 and "attendance_punches"."lng" between -180 and 180 and "attendance_punches"."accuracy_m" between 0 and 100000)));--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_break_ck" CHECK ("shifts"."break_minutes" between 0 and 240);