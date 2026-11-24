CREATE TABLE "shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "shift_assignments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_assignments_from_uq" UNIQUE("tenant_id","employee_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"grace_minutes" smallint DEFAULT 15 NOT NULL,
	"half_day_minutes" smallint DEFAULT 240 NOT NULL,
	"full_day_minutes" smallint DEFAULT 480 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "shifts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shifts_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "shifts_name_ck" CHECK (length(trim("shifts"."name")) between 1 and 60),
	CONSTRAINT "shifts_times_ck" CHECK ("shifts"."start_time" <> "shifts"."end_time"),
	CONSTRAINT "shifts_grace_ck" CHECK ("shifts"."grace_minutes" between 0 and 240),
	CONSTRAINT "shifts_minutes_ck" CHECK ("shifts"."half_day_minutes" between 1 and "shifts"."full_day_minutes" and "shifts"."full_day_minutes" <= 1440),
	CONSTRAINT "shifts_default_active_ck" CHECK (not "shifts"."is_default" or "shifts"."active")
);
--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_default_uq" ON "shifts" USING btree ("tenant_id") WHERE "shifts"."is_default";