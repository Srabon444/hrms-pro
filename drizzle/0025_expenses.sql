CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"claim_limit" integer,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "expense_categories_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_categories_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "expense_categories_name_ck" CHECK (length(trim("expense_categories"."name")) between 1 and 60),
	CONSTRAINT "expense_categories_limit_ck" CHECK ("expense_categories"."claim_limit" is null or "expense_categories"."claim_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"total" integer NOT NULL,
	"pay_via" text,
	"submitted_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" uuid,
	"payroll_run_id" uuid,
	CONSTRAINT "expense_claims_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_claims_title_ck" CHECK (length(trim("expense_claims"."title")) between 1 and 120),
	CONSTRAINT "expense_claims_status_ck" CHECK ("expense_claims"."status" in ('submitted','approved','rejected','paid','cancelled')),
	CONSTRAINT "expense_claims_pay_via_ck" CHECK ("expense_claims"."pay_via" is null or "expense_claims"."pay_via" in ('payroll','direct')),
	CONSTRAINT "expense_claims_note_ck" CHECK ("expense_claims"."decision_note" is null or length("expense_claims"."decision_note") <= 300),
	CONSTRAINT "expense_claims_total_ck" CHECK ("expense_claims"."total" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"spent_on" date NOT NULL,
	"description" text NOT NULL,
	"amount" integer NOT NULL,
	"receipt_key" text,
	"receipt_name" text,
	"receipt_type" text,
	"receipt_size" integer,
	CONSTRAINT "expense_items_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_items_description_ck" CHECK (length(trim("expense_items"."description")) between 1 and 200),
	CONSTRAINT "expense_items_amount_ck" CHECK ("expense_items"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_claim_fk" FOREIGN KEY ("tenant_id","claim_id") REFERENCES "public"."expense_claims"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."expense_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_claims_employee_idx" ON "expense_claims" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "expense_claims_status_idx" ON "expense_claims" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "expense_items_claim_idx" ON "expense_items" USING btree ("tenant_id","claim_id");--> statement-breakpoint
CREATE INDEX "expense_items_category_idx" ON "expense_items" USING btree ("tenant_id","category_id");