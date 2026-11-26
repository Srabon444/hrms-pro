CREATE TABLE "work_week_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_week_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "work_week_assignments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "work_week_assignments_from_uq" UNIQUE("tenant_id","employee_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "work_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"weekend_days" smallint[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "work_weeks_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "work_weeks_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "work_weeks_name_ck" CHECK (length(trim("work_weeks"."name")) between 1 and 60),
	CONSTRAINT "work_weeks_days_ck" CHECK (cardinality("work_weeks"."weekend_days") <= 7 and "work_weeks"."weekend_days" <@ '{0,1,2,3,4,5,6}'::smallint[])
);
--> statement-breakpoint
ALTER TABLE "work_week_assignments" ADD CONSTRAINT "work_week_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_week_assignments" ADD CONSTRAINT "work_week_assignments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_week_assignments" ADD CONSTRAINT "work_week_assignments_week_fk" FOREIGN KEY ("tenant_id","work_week_id") REFERENCES "public"."work_weeks"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_weeks" ADD CONSTRAINT "work_weeks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;