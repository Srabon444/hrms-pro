CREATE TABLE "employee_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relation" text NOT NULL,
	"phone" text NOT NULL,
	CONSTRAINT "employee_contacts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_contacts_name_ck" CHECK (length(trim("employee_contacts"."name")) between 1 and 160),
	CONSTRAINT "employee_contacts_relation_ck" CHECK (length(trim("employee_contacts"."relation")) between 1 and 60),
	CONSTRAINT "employee_contacts_phone_ck" CHECK (length(trim("employee_contacts"."phone")) between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "employee_education" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"degree" text NOT NULL,
	"institution" text NOT NULL,
	"passing_year" smallint,
	CONSTRAINT "employee_education_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_education_degree_ck" CHECK (length(trim("employee_education"."degree")) between 1 and 160),
	CONSTRAINT "employee_education_institution_ck" CHECK (length(trim("employee_education"."institution")) between 1 and 160),
	CONSTRAINT "employee_education_year_ck" CHECK ("employee_education"."passing_year" between 1950 and 2100)
);
--> statement-breakpoint
CREATE TABLE "employee_experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	CONSTRAINT "employee_experience_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_experience_company_ck" CHECK (length(trim("employee_experience"."company")) between 1 and 160),
	CONSTRAINT "employee_experience_title_ck" CHECK (length(trim("employee_experience"."title")) between 1 and 160),
	CONSTRAINT "employee_experience_dates_ck" CHECK ("employee_experience"."end_date" is null or "employee_experience"."end_date" >= "employee_experience"."start_date")
);
--> statement-breakpoint
ALTER TABLE "employee_contacts" ADD CONSTRAINT "employee_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contacts" ADD CONSTRAINT "employee_contacts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_education" ADD CONSTRAINT "employee_education_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_education" ADD CONSTRAINT "employee_education_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_experience" ADD CONSTRAINT "employee_experience_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_experience" ADD CONSTRAINT "employee_experience_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_contacts_employee_idx" ON "employee_contacts" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "employee_education_employee_idx" ON "employee_education" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "employee_experience_employee_idx" ON "employee_experience" USING btree ("tenant_id","employee_id");