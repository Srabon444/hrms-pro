CREATE TABLE "per_diem_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"country" text NOT NULL,
	"city" text,
	"daily_amount" integer NOT NULL,
	CONSTRAINT "per_diem_rates_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "per_diem_rates_country_ck" CHECK (length(trim("per_diem_rates"."country")) between 1 and 60),
	CONSTRAINT "per_diem_rates_city_ck" CHECK ("per_diem_rates"."city" is null or length(trim("per_diem_rates"."city")) between 1 and 60),
	CONSTRAINT "per_diem_rates_amount_ck" CHECK ("per_diem_rates"."daily_amount" between 1 and 99999999)
);
--> statement-breakpoint
CREATE TABLE "travel_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"country" text NOT NULL,
	"city" text,
	"depart_on" date NOT NULL,
	"return_on" date NOT NULL,
	"estimated_cost" integer NOT NULL,
	"advance" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"loan_id" uuid,
	CONSTRAINT "travel_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "travel_requests_purpose_ck" CHECK (length(trim("travel_requests"."purpose")) between 1 and 200),
	CONSTRAINT "travel_requests_country_ck" CHECK (length(trim("travel_requests"."country")) between 1 and 60),
	CONSTRAINT "travel_requests_city_ck" CHECK ("travel_requests"."city" is null or length(trim("travel_requests"."city")) between 1 and 60),
	CONSTRAINT "travel_requests_dates_ck" CHECK ("travel_requests"."return_on" >= "travel_requests"."depart_on"),
	CONSTRAINT "travel_requests_cost_ck" CHECK ("travel_requests"."estimated_cost" between 0 and 999999999),
	CONSTRAINT "travel_requests_advance_ck" CHECK ("travel_requests"."advance" between 0 and "travel_requests"."estimated_cost"),
	CONSTRAINT "travel_requests_status_ck" CHECK ("travel_requests"."status" in ('submitted','approved','rejected','cancelled')),
	CONSTRAINT "travel_requests_note_ck" CHECK ("travel_requests"."decision_note" is null or length("travel_requests"."decision_note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "expense_claims" ADD COLUMN "travel_request_id" uuid;--> statement-breakpoint
ALTER TABLE "per_diem_rates" ADD CONSTRAINT "per_diem_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "per_diem_rates_place_uq" ON "per_diem_rates" USING btree ("tenant_id",lower("country"),lower(coalesce("city", '')));--> statement-breakpoint
CREATE INDEX "travel_requests_employee_idx" ON "travel_requests" USING btree ("tenant_id","employee_id");--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_trip_fk" FOREIGN KEY ("tenant_id","travel_request_id") REFERENCES "public"."travel_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_claims_trip_idx" ON "expense_claims" USING btree ("tenant_id","travel_request_id");