CREATE TABLE "employee_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by_user_id" uuid,
	CONSTRAINT "employee_history_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"work_email" "citext",
	"personal_email" "citext",
	"phone" text,
	"date_of_birth" date,
	"gender" text,
	"blood_group" text,
	"present_address" text,
	"permanent_address" text,
	"national_id" text,
	"passport_number" text,
	"tax_id" text,
	"bank_name" text,
	"bank_account_name" text,
	"bank_account_number" text,
	"department_id" uuid,
	"designation_id" uuid,
	"grade_id" uuid,
	"branch_id" uuid,
	"manager_id" uuid,
	"employment_type" text DEFAULT 'full_time' NOT NULL,
	"join_date" date NOT NULL,
	"probation_end_date" date,
	"confirmation_date" date,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"exit_date" date,
	"exit_reason" text,
	CONSTRAINT "employees_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employees_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "employees_work_email_uq" UNIQUE("tenant_id","work_email"),
	CONSTRAINT "employees_name_ck" CHECK (length(trim("employees"."full_name")) between 1 and 160),
	CONSTRAINT "employees_not_own_manager_ck" CHECK ("employees"."manager_id" is distinct from "employees"."id"),
	CONSTRAINT "employees_status_ck" CHECK ("employees"."status" in ('onboarding','probation','active','notice','exited')),
	CONSTRAINT "employees_type_ck" CHECK ("employees"."employment_type" in ('full_time','part_time','contract','intern')),
	CONSTRAINT "employees_gender_ck" CHECK ("employees"."gender" is null or "employees"."gender" in ('female','male','other','undisclosed')),
	CONSTRAINT "employees_exit_ck" CHECK ("employees"."exit_date" is null or "employees"."exit_date" >= "employees"."join_date")
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "head_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_history" ADD CONSTRAINT "employee_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_history" ADD CONSTRAINT "employee_history_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_designation_fk" FOREIGN KEY ("tenant_id","designation_id") REFERENCES "public"."designations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."grades"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_history_employee_idx" ON "employee_history" USING btree ("tenant_id","employee_id","created_at");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "employees" USING btree ("tenant_id","department_id");--> statement-breakpoint
CREATE INDEX "employees_manager_idx" ON "employees" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_fk" FOREIGN KEY ("tenant_id","head_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;