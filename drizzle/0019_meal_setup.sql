CREATE TABLE "meal_type_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meal_type_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"unit_cost" integer NOT NULL,
	"subsidy_pct" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "meal_type_prices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_type_prices_from_uq" UNIQUE("tenant_id","meal_type_id","effective_from"),
	CONSTRAINT "meal_type_prices_cost_ck" CHECK ("meal_type_prices"."unit_cost" between 1 and 1000000),
	CONSTRAINT "meal_type_prices_subsidy_ck" CHECK ("meal_type_prices"."subsidy_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "meal_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "meal_types_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_types_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "meal_types_name_ck" CHECK (length(trim("meal_types"."name")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "meal_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "meal_vendors_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_vendors_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "meal_vendors_name_ck" CHECK (length(trim("meal_vendors"."name")) between 1 and 100),
	CONSTRAINT "meal_vendors_contact_ck" CHECK ("meal_vendors"."contact" is null or length("meal_vendors"."contact") <= 200)
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "meal_cutoff_time" time DEFAULT '10:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "meal_mode" text DEFAULT 'opt_out' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "meal_working_days_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "meal_billing_mode" text DEFAULT 'payroll' NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_type_prices" ADD CONSTRAINT "meal_type_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_type_prices" ADD CONSTRAINT "meal_type_prices_type_fk" FOREIGN KEY ("tenant_id","meal_type_id") REFERENCES "public"."meal_types"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_types" ADD CONSTRAINT "meal_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_types" ADD CONSTRAINT "meal_types_vendor_fk" FOREIGN KEY ("tenant_id","vendor_id") REFERENCES "public"."meal_vendors"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_vendors" ADD CONSTRAINT "meal_vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_meal_mode_ck" CHECK ("tenant_settings"."meal_mode" in ('opt_out','opt_in'));--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_meal_billing_ck" CHECK ("tenant_settings"."meal_billing_mode" in ('payroll','direct'));