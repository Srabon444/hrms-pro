CREATE TABLE "meal_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"paid_on" date NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid,
	CONSTRAINT "meal_payments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_payments_amount_ck" CHECK ("meal_payments"."amount" > 0),
	CONSTRAINT "meal_payments_method_ck" CHECK ("meal_payments"."method" in ('cash','bank','mobile')),
	CONSTRAINT "meal_payments_note_ck" CHECK ("meal_payments"."note" is null or length("meal_payments"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "meal_payments" ADD CONSTRAINT "meal_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_payments" ADD CONSTRAINT "meal_payments_bill_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."meal_bills"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_payments_bill_ix" ON "meal_payments" USING btree ("tenant_id","bill_id");