CREATE TABLE "meal_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bill_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"meal" text NOT NULL,
	"plates" smallint NOT NULL,
	"guests" smallint NOT NULL,
	"unit_cost" integer NOT NULL,
	"subsidy_pct" smallint NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "meal_bill_lines_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_bill_lines_kind_ck" CHECK ("meal_bill_lines"."kind" in ('meal','adjustment'))
);
--> statement-breakpoint
CREATE TABLE "meal_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"billing_mode" text NOT NULL,
	"total" integer NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	"payroll_run_id" uuid,
	"pdf_key" text,
	CONSTRAINT "meal_bills_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_bills_period_ck" CHECK ("meal_bills"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "meal_bills_status_ck" CHECK ("meal_bills"."status" in ('draft','issued','partially_paid','paid','deducted','void')),
	CONSTRAINT "meal_bills_mode_ck" CHECK ("meal_bills"."billing_mode" in ('payroll','direct')),
	CONSTRAINT "meal_bills_paid_ck" CHECK ("meal_bills"."paid" >= 0 and "meal_bills"."paid" <= greatest("meal_bills"."total", 0))
);
--> statement-breakpoint
ALTER TABLE "meal_bill_lines" ADD CONSTRAINT "meal_bill_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_bill_lines" ADD CONSTRAINT "meal_bill_lines_bill_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."meal_bills"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_bill_lines" ADD CONSTRAINT "meal_bill_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."meal_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_bills" ADD CONSTRAINT "meal_bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_bills" ADD CONSTRAINT "meal_bills_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_bills_period_uq" ON "meal_bills" USING btree ("tenant_id","employee_id","period") WHERE "meal_bills"."status" <> 'void';