CREATE TABLE "leave_request_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"session" text NOT NULL,
	"fiscal_year" smallint NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "leave_request_days_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_request_days_session_ck" CHECK ("leave_request_days"."session" in ('full','am','pm')),
	CONSTRAINT "leave_request_days_status_ck" CHECK ("leave_request_days"."status" in ('pending','approved','rejected','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"session" text NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "leave_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_requests_range_ck" CHECK ("leave_requests"."end_date" >= "leave_requests"."start_date"),
	CONSTRAINT "leave_requests_session_ck" CHECK ("leave_requests"."session" = 'full' or ("leave_requests"."session" in ('am','pm') and "leave_requests"."start_date" = "leave_requests"."end_date")),
	CONSTRAINT "leave_requests_status_ck" CHECK ("leave_requests"."status" in ('pending','approved','rejected','cancelled')),
	CONSTRAINT "leave_requests_days_ck" CHECK ("leave_requests"."days" >= 0 and "leave_requests"."days" <= 366),
	CONSTRAINT "leave_requests_notes_ck" CHECK (coalesce(length("leave_requests"."reason"), 0) <= 500 and coalesce(length("leave_requests"."decision_note"), 0) <= 500)
);
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."leave_requests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_type_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_days_active_uq" ON "leave_request_days" USING btree ("tenant_id","employee_id","date","session") WHERE "leave_request_days"."status" in ('pending','approved');--> statement-breakpoint
CREATE INDEX "leave_request_days_date_ix" ON "leave_request_days" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "leave_request_days_request_ix" ON "leave_request_days" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_ix" ON "leave_requests" USING btree ("tenant_id","employee_id","start_date");--> statement-breakpoint
CREATE INDEX "leave_requests_status_ix" ON "leave_requests" USING btree ("tenant_id","status");