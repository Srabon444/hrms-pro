CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"allocation" smallint DEFAULT 100 NOT NULL,
	CONSTRAINT "project_members_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "project_members_uq" UNIQUE("tenant_id","project_id","employee_id"),
	CONSTRAINT "project_members_role_ck" CHECK ("project_members"."role" in ('member','lead')),
	CONSTRAINT "project_members_allocation_ck" CHECK ("project_members"."allocation" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"client" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "projects_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "projects_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "projects_code_ck" CHECK ("projects"."code" ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'),
	CONSTRAINT "projects_name_ck" CHECK (length(trim("projects"."name")) between 1 and 120),
	CONSTRAINT "projects_client_ck" CHECK (length("projects"."client") <= 120),
	CONSTRAINT "projects_status_ck" CHECK ("projects"."status" in ('active','on_hold','closed'))
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"timesheet_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"minutes" smallint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "timesheet_entries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "timesheet_entries_uq" UNIQUE("tenant_id","timesheet_id","project_id","work_date"),
	CONSTRAINT "timesheet_entries_minutes_ck" CHECK ("timesheet_entries"."minutes" between 15 and 1440 and "timesheet_entries"."minutes" % 15 = 0),
	CONSTRAINT "timesheet_entries_note_ck" CHECK (length("timesheet_entries"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "timesheets_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "timesheets_week_uq" UNIQUE("tenant_id","employee_id","week_start"),
	CONSTRAINT "timesheets_status_ck" CHECK ("timesheets"."status" in ('draft','submitted','approved','rejected')),
	CONSTRAINT "timesheets_submitted_ck" CHECK (("timesheets"."status" = 'draft') = ("timesheets"."submitted_at" is null)),
	CONSTRAINT "timesheets_decided_ck" CHECK (("timesheets"."status" in ('approved','rejected')) = ("timesheets"."decided_at" is not null)),
	CONSTRAINT "timesheets_note_ck" CHECK (length("timesheets"."decision_note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_sheet_fk" FOREIGN KEY ("tenant_id","timesheet_id") REFERENCES "public"."timesheets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_employee_idx" ON "project_members" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "timesheet_entries_project_idx" ON "timesheet_entries" USING btree ("tenant_id","project_id","work_date");--> statement-breakpoint
CREATE INDEX "timesheets_status_idx" ON "timesheets" USING btree ("tenant_id","status");