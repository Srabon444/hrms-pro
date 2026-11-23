CREATE TABLE "employee_salaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"gross" integer NOT NULL,
	"change_id" uuid NOT NULL,
	CONSTRAINT "employee_salaries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_salaries_change_uq" UNIQUE("tenant_id","change_id"),
	CONSTRAINT "employee_salaries_range_ck" CHECK ("employee_salaries"."effective_to" is null or "employee_salaries"."effective_to" >= "employee_salaries"."effective_from"),
	CONSTRAINT "employee_salaries_gross_ck" CHECK ("employee_salaries"."gross" > 0)
);
--> statement-breakpoint
CREATE TABLE "employee_salary_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"salary_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "employee_salary_lines_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_salary_lines_uq" UNIQUE("tenant_id","salary_id","component_id"),
	CONSTRAINT "employee_salary_lines_value_ck" CHECK ("employee_salary_lines"."value" >= 0 and "employee_salary_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pay_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"calc" text DEFAULT 'fixed' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pay_components_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_components_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "pay_components_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "pay_components_code_ck" CHECK ("pay_components"."code" ~ '^[A-Z][A-Z0-9_]{1,19}$'),
	CONSTRAINT "pay_components_name_ck" CHECK (length(trim("pay_components"."name")) between 1 and 60),
	CONSTRAINT "pay_components_kind_ck" CHECK ("pay_components"."kind" in ('earning','deduction')),
	CONSTRAINT "pay_components_calc_ck" CHECK ("pay_components"."calc" in ('fixed','pct_basic'))
);
--> statement-breakpoint
CREATE TABLE "salary_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lines" jsonb NOT NULL,
	"gross" integer NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "salary_changes_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "salary_changes_status_ck" CHECK ("salary_changes"."status" in ('pending','approved','rejected')),
	CONSTRAINT "salary_changes_reason_ck" CHECK (length(trim("salary_changes"."reason")) between 1 and 300),
	CONSTRAINT "salary_changes_note_ck" CHECK ("salary_changes"."decision_note" is null or length("salary_changes"."decision_note") <= 300),
	CONSTRAINT "salary_changes_gross_ck" CHECK ("salary_changes"."gross" > 0)
);
--> statement-breakpoint
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_change_fk" FOREIGN KEY ("tenant_id","change_id") REFERENCES "public"."salary_changes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_lines" ADD CONSTRAINT "employee_salary_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_lines" ADD CONSTRAINT "employee_salary_lines_salary_fk" FOREIGN KEY ("tenant_id","salary_id") REFERENCES "public"."employee_salaries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_lines" ADD CONSTRAINT "employee_salary_lines_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_lines" ADD CONSTRAINT "employee_salary_lines_component_fk" FOREIGN KEY ("tenant_id","component_id") REFERENCES "public"."pay_components"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_changes" ADD CONSTRAINT "salary_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_changes" ADD CONSTRAINT "salary_changes_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_salary_lines_component_idx" ON "employee_salary_lines" USING btree ("tenant_id","component_id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_changes_pending_uq" ON "salary_changes" USING btree ("tenant_id","employee_id") WHERE "salary_changes"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "employee_id" WITH =, daterange("effective_from", "effective_to", '[]') WITH &&);
