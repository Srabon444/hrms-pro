CREATE TABLE "attendance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"punch_at" timestamp with time zone,
	"minutes" smallint,
	"approved_minutes" smallint,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "attendance_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_requests_kind_ck" CHECK ("attendance_requests"."kind" in ('regularization','wfh','overtime')),
	CONSTRAINT "attendance_requests_status_ck" CHECK ("attendance_requests"."status" in ('pending','approved','rejected','cancelled')),
	CONSTRAINT "attendance_requests_shape_ck" CHECK (("attendance_requests"."kind" = 'regularization') = ("attendance_requests"."punch_at" is not null) and ("attendance_requests"."kind" = 'overtime') = ("attendance_requests"."minutes" is not null) and ("attendance_requests"."approved_minutes" is null or "attendance_requests"."kind" = 'overtime')),
	CONSTRAINT "attendance_requests_minutes_ck" CHECK (("attendance_requests"."minutes" is null or "attendance_requests"."minutes" between 15 and 1440) and ("attendance_requests"."approved_minutes" is null or "attendance_requests"."approved_minutes" between 15 and "attendance_requests"."minutes")),
	CONSTRAINT "attendance_requests_notes_ck" CHECK (length(trim("attendance_requests"."reason")) between 1 and 500 and coalesce(length("attendance_requests"."decision_note"), 0) <= 500)
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "overtime_daily_cap_minutes" smallint DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_requests" ADD CONSTRAINT "attendance_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_requests" ADD CONSTRAINT "attendance_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_requests_employee_ix" ON "attendance_requests" USING btree ("tenant_id","employee_id","date");--> statement-breakpoint
CREATE INDEX "attendance_requests_status_ix" ON "attendance_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_requests_day_uq" ON "attendance_requests" USING btree ("tenant_id","employee_id","kind","date") WHERE "attendance_requests"."kind" in ('wfh','overtime') and "attendance_requests"."status" in ('pending','approved');--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_requests_punch_uq" ON "attendance_requests" USING btree ("tenant_id","employee_id","punch_at") WHERE "attendance_requests"."kind" = 'regularization' and "attendance_requests"."status" in ('pending','approved');--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_overtime_ck" CHECK ("tenant_settings"."overtime_daily_cap_minutes" between 15 and 720);