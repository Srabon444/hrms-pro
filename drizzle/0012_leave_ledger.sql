CREATE TABLE "leave_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"fiscal_year" smallint NOT NULL,
	"kind" text NOT NULL,
	"days" numeric(6, 2) NOT NULL,
	"period" text,
	"ref_id" uuid,
	"expires_on" date,
	"note" text,
	"created_by_user_id" uuid,
	CONSTRAINT "leave_ledger_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_ledger_kind_ck" CHECK ("leave_ledger"."kind" in ('accrual','taken','adjustment','carry','expiry','encash','comp_credit')),
	CONSTRAINT "leave_ledger_days_ck" CHECK ("leave_ledger"."days" <> 0 and abs("leave_ledger"."days") <= 366),
	CONSTRAINT "leave_ledger_note_ck" CHECK ("leave_ledger"."note" is null or length("leave_ledger"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_type_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_ledger_period_uq" ON "leave_ledger" USING btree ("tenant_id","employee_id","leave_type_id","fiscal_year","kind","period") WHERE "leave_ledger"."period" is not null;--> statement-breakpoint
CREATE INDEX "leave_ledger_balance_ix" ON "leave_ledger" USING btree ("tenant_id","employee_id","fiscal_year","leave_type_id");