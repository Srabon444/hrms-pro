CREATE TABLE "attendance_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"shift_id" uuid,
	"status" text NOT NULL,
	"first_in" timestamp with time zone,
	"last_out" timestamp with time zone,
	"worked_minutes" smallint DEFAULT 0 NOT NULL,
	"late_minutes" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "attendance_days_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_days_day_uq" UNIQUE("tenant_id","employee_id","date"),
	CONSTRAINT "attendance_days_status_ck" CHECK ("attendance_days"."status" in ('present','late','half_day','absent','on_leave','holiday','weekend','wfh')),
	CONSTRAINT "attendance_days_minutes_ck" CHECK ("attendance_days"."worked_minutes" between 0 and 1440 and "attendance_days"."late_minutes" between 0 and 1440)
);
--> statement-breakpoint
CREATE TABLE "attendance_punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"ip" text,
	"created_by_user_id" uuid,
	CONSTRAINT "attendance_punches_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_punches_at_uq" UNIQUE("tenant_id","employee_id","at"),
	CONSTRAINT "attendance_punches_source_ck" CHECK ("attendance_punches"."source" in ('web','manual','device','regularization')),
	CONSTRAINT "attendance_punches_ip_ck" CHECK ("attendance_punches"."ip" is null or length("attendance_punches"."ip") <= 64)
);
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_days_date_idx" ON "attendance_days" USING btree ("tenant_id","date");