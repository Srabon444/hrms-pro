CREATE TABLE "resignations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"submitted_on" date NOT NULL,
	"notice_days" integer NOT NULL,
	"requested_last_day" date NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"manager_user_id" uuid,
	"manager_at" timestamp with time zone,
	"manager_note" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"approved_last_day" date,
	CONSTRAINT "resignations_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "resignations_status_ck" CHECK ("resignations"."status" in ('pending_manager','pending_hr','approved','rejected','withdrawn')),
	CONSTRAINT "resignations_reason_ck" CHECK (length("resignations"."reason") between 1 and 500),
	CONSTRAINT "resignations_notes_ck" CHECK (coalesce(length("resignations"."manager_note"), 0) <= 500 and coalesce(length("resignations"."decision_note"), 0) <= 500),
	CONSTRAINT "resignations_last_day_ck" CHECK ("resignations"."requested_last_day" >= "resignations"."submitted_on")
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "notice_period_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resignations_one_open_uq" ON "resignations" USING btree ("tenant_id","employee_id") WHERE "resignations"."status" in ('pending_manager','pending_hr');--> statement-breakpoint
CREATE INDEX "resignations_status_idx" ON "resignations" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_notice_ck" CHECK ("tenant_settings"."notice_period_days" between 0 and 365);