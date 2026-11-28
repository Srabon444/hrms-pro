CREATE TABLE "comp_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"budget" integer NOT NULL,
	CONSTRAINT "comp_budgets_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "comp_budgets_department_uq" UNIQUE("tenant_id","cycle_id","department_id"),
	CONSTRAINT "comp_budgets_budget_ck" CHECK ("comp_budgets"."budget" between 0 and 999999999)
);
--> statement-breakpoint
CREATE TABLE "comp_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"guideline_bp" integer,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "comp_cycles_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "comp_cycles_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "comp_cycles_name_ck" CHECK (length(trim("comp_cycles"."name")) between 1 and 80),
	CONSTRAINT "comp_cycles_status_ck" CHECK ("comp_cycles"."status" in ('open','closed')),
	CONSTRAINT "comp_cycles_guideline_ck" CHECK ("comp_cycles"."guideline_bp" is null or "comp_cycles"."guideline_bp" between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "comp_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"current_gross" integer NOT NULL,
	"change_bp" integer NOT NULL,
	"proposed_gross" integer NOT NULL,
	"reason" text NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"salary_change_id" uuid,
	CONSTRAINT "comp_proposals_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "comp_proposals_employee_uq" UNIQUE("tenant_id","cycle_id","employee_id"),
	CONSTRAINT "comp_proposals_change_bp_ck" CHECK ("comp_proposals"."change_bp" between 1 and 10000),
	CONSTRAINT "comp_proposals_gross_ck" CHECK ("comp_proposals"."current_gross" > 0 and "comp_proposals"."proposed_gross" > 0),
	CONSTRAINT "comp_proposals_reason_ck" CHECK (length(trim("comp_proposals"."reason")) between 1 and 200),
	CONSTRAINT "comp_proposals_status_ck" CHECK ("comp_proposals"."status" in ('proposed','applied')),
	CONSTRAINT "comp_proposals_applied_ck" CHECK (("comp_proposals"."status" = 'applied') = ("comp_proposals"."salary_change_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "comp_budgets" ADD CONSTRAINT "comp_budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_budgets" ADD CONSTRAINT "comp_budgets_cycle_fk" FOREIGN KEY ("tenant_id","cycle_id") REFERENCES "public"."comp_cycles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_budgets" ADD CONSTRAINT "comp_budgets_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_cycles" ADD CONSTRAINT "comp_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_proposals" ADD CONSTRAINT "comp_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_proposals" ADD CONSTRAINT "comp_proposals_cycle_fk" FOREIGN KEY ("tenant_id","cycle_id") REFERENCES "public"."comp_cycles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_proposals" ADD CONSTRAINT "comp_proposals_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_proposals" ADD CONSTRAINT "comp_proposals_change_fk" FOREIGN KEY ("tenant_id","salary_change_id") REFERENCES "public"."salary_changes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;