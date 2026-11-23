CREATE TABLE "loan_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loan_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"payroll_run_id" uuid,
	"paid_at" timestamp with time zone,
	CONSTRAINT "loan_instalments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_instalments_period_uq" UNIQUE("tenant_id","loan_id","period"),
	CONSTRAINT "loan_instalments_period_ck" CHECK ("loan_instalments"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "loan_instalments_amount_ck" CHECK ("loan_instalments"."amount" > 0),
	CONSTRAINT "loan_instalments_status_ck" CHECK ("loan_instalments"."status" in ('due','paid'))
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"instalments" integer NOT NULL,
	"start_period" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "loans_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "loans_kind_ck" CHECK ("loans"."kind" in ('loan','advance')),
	CONSTRAINT "loans_status_ck" CHECK ("loans"."status" in ('requested','approved','rejected','cancelled','closed')),
	CONSTRAINT "loans_amount_ck" CHECK ("loans"."amount" > 0),
	CONSTRAINT "loans_instalments_ck" CHECK ("loans"."instalments" between 1 and 60),
	CONSTRAINT "loans_start_ck" CHECK ("loans"."start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "loans_reason_ck" CHECK (length(trim("loans"."reason")) between 1 and 300),
	CONSTRAINT "loans_note_ck" CHECK ("loans"."decision_note" is null or length("loans"."decision_note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_instalments_due_idx" ON "loan_instalments" USING btree ("tenant_id","employee_id","period");--> statement-breakpoint
CREATE INDEX "loans_employee_idx" ON "loans" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_requested_uq" ON "loans" USING btree ("tenant_id","employee_id") WHERE "loans"."status" = 'requested';