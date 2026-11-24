CREATE TABLE "employee_tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tax_year_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"category" text NOT NULL,
	"prev_employer_income" integer DEFAULT 0 NOT NULL,
	"prev_tax_paid" integer DEFAULT 0 NOT NULL,
	"rebate" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "employee_tax_profiles_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_tax_profiles_uq" UNIQUE("tenant_id","tax_year_id","employee_id"),
	CONSTRAINT "employee_tax_profiles_category_ck" CHECK ("employee_tax_profiles"."category" in ('general','female_senior','disabled','freedom_fighter')),
	CONSTRAINT "employee_tax_profiles_amounts_ck" CHECK ("employee_tax_profiles"."prev_employer_income" >= 0 and "employee_tax_profiles"."prev_tax_paid" >= 0 and "employee_tax_profiles"."rebate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tax_year_id" uuid NOT NULL,
	"category" text NOT NULL,
	"seq" integer NOT NULL,
	"width" integer,
	"rate_bp" integer NOT NULL,
	CONSTRAINT "tax_slabs_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_slabs_seq_uq" UNIQUE("tenant_id","tax_year_id","category","seq"),
	CONSTRAINT "tax_slabs_category_ck" CHECK ("tax_slabs"."category" in ('general','female_senior','disabled','freedom_fighter')),
	CONSTRAINT "tax_slabs_width_ck" CHECK ("tax_slabs"."width" is null or "tax_slabs"."width" > 0),
	CONSTRAINT "tax_slabs_rate_ck" CHECK ("tax_slabs"."rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "tax_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fy" text NOT NULL,
	"minimum_tax" integer NOT NULL,
	"exemption_cap" integer NOT NULL,
	"exemption_divisor" integer NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "tax_years_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_years_fy_uq" UNIQUE("tenant_id","fy"),
	CONSTRAINT "tax_years_fy_ck" CHECK ("tax_years"."fy" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "tax_years_minimum_ck" CHECK ("tax_years"."minimum_tax" >= 0),
	CONSTRAINT "tax_years_cap_ck" CHECK ("tax_years"."exemption_cap" >= 0),
	CONSTRAINT "tax_years_divisor_ck" CHECK ("tax_years"."exemption_divisor" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "employee_tax_profiles" ADD CONSTRAINT "employee_tax_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_tax_profiles" ADD CONSTRAINT "employee_tax_profiles_year_fk" FOREIGN KEY ("tenant_id","tax_year_id") REFERENCES "public"."tax_years"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_tax_profiles" ADD CONSTRAINT "employee_tax_profiles_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_slabs" ADD CONSTRAINT "tax_slabs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_slabs" ADD CONSTRAINT "tax_slabs_year_fk" FOREIGN KEY ("tenant_id","tax_year_id") REFERENCES "public"."tax_years"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_years" ADD CONSTRAINT "tax_years_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;