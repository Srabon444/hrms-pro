CREATE TABLE "availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"weekday" smallint,
	"date" date,
	"from_time" time NOT NULL,
	"to_time" time NOT NULL,
	"note" text,
	CONSTRAINT "availability_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "availability_when_ck" CHECK (("availability"."weekday" is null) <> ("availability"."date" is null) and ("availability"."weekday" is null or "availability"."weekday" between 0 and 6)),
	CONSTRAINT "availability_times_ck" CHECK ("availability"."from_time" < "availability"."to_time"),
	CONSTRAINT "availability_note_ck" CHECK ("availability"."note" is null or length("availability"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid,
	"date" date NOT NULL,
	"shift_id" uuid,
	"kind" text DEFAULT 'work' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "roster_entries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "roster_entries_kind_ck" CHECK ("roster_entries"."kind" in ('work','off')),
	CONSTRAINT "roster_entries_status_ck" CHECK ("roster_entries"."status" in ('draft','published')),
	CONSTRAINT "roster_entries_shift_ck" CHECK (("roster_entries"."kind" = 'work') = ("roster_entries"."shift_id" is not null)),
	CONSTRAINT "roster_entries_note_ck" CHECK ("roster_entries"."note" is null or length("roster_entries"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "work_weeks" ADD COLUMN "roster_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_employee_idx" ON "availability" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_entries_day_uq" ON "roster_entries" USING btree ("tenant_id","employee_id","date") WHERE "roster_entries"."employee_id" is not null;--> statement-breakpoint
CREATE INDEX "roster_entries_date_idx" ON "roster_entries" USING btree ("tenant_id","date");