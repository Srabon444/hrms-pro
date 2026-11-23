CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "change_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "change_requests_status_ck" CHECK ("change_requests"."status" in ('pending','approved','rejected','cancelled')),
	CONSTRAINT "change_requests_note_ck" CHECK ("change_requests"."decision_note" is null or length("change_requests"."decision_note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_one_pending_uq" ON "change_requests" USING btree ("tenant_id","employee_id") WHERE "change_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "change_requests_status_idx" ON "change_requests" USING btree ("tenant_id","status");