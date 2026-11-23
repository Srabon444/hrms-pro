CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_type" text DEFAULT 'regular' NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'computed' NOT NULL,
	"inputs_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"computed_by_user_id" uuid NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"paid_by_user_id" uuid,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payroll_runs_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_runs_period_ck" CHECK ("payroll_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_runs_type_ck" CHECK ("payroll_runs"."run_type" in ('regular','bonus','arrears','final')),
	CONSTRAINT "payroll_runs_status_ck" CHECK ("payroll_runs"."status" in ('computed','approved','paid','void'))
);
--> statement-breakpoint
CREATE TABLE "payslip_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payslip_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"taxable" boolean NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "payslip_lines_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payslip_lines_seq_uq" UNIQUE("tenant_id","payslip_id","seq"),
	CONSTRAINT "payslip_lines_kind_ck" CHECK ("payslip_lines"."kind" in ('earning','deduction','employer')),
	CONSTRAINT "payslip_lines_amount_ck" CHECK ("payslip_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"paid_days" integer DEFAULT 0 NOT NULL,
	"unpaid_days" numeric(5, 1) DEFAULT 0 NOT NULL,
	"gross" integer DEFAULT 0 NOT NULL,
	"deductions" integer DEFAULT 0 NOT NULL,
	"rounding" integer DEFAULT 0 NOT NULL,
	"net" integer DEFAULT 0 NOT NULL,
	"taxable" integer DEFAULT 0 NOT NULL,
	"tax" integer DEFAULT 0 NOT NULL,
	"error" text,
	"notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"pdf_key" text,
	CONSTRAINT "payslips_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payslips_run_employee_uq" UNIQUE("tenant_id","run_id","employee_id"),
	CONSTRAINT "payslips_net_ck" CHECK ("payslips"."net" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_fk" FOREIGN KEY ("tenant_id","payslip_id") REFERENCES "public"."payslips"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_regular_uq" ON "payroll_runs" USING btree ("tenant_id","period") WHERE "payroll_runs"."run_type" = 'regular' and "payroll_runs"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "payslips_employee_idx" ON "payslips" USING btree ("tenant_id","employee_id");--> statement-breakpoint
ALTER TABLE "meal_bills" ADD CONSTRAINT "meal_bills_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_run_fk" FOREIGN KEY ("tenant_id","payroll_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;