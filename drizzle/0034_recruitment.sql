CREATE TABLE "candidate_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"moved_by_user_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "candidate_stage_history_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "candidate_stage_history_note_ck" CHECK (length("candidate_stage_history"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email" "citext",
	"phone" text,
	"source" text DEFAULT 'other' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"resume_key" text,
	"resume_name" text,
	"resume_type" text,
	"resume_size" integer,
	"employee_id" uuid,
	"created_by_user_id" uuid,
	CONSTRAINT "candidates_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "candidates_name_ck" CHECK (length(trim("candidates"."full_name")) between 1 and 120),
	CONSTRAINT "candidates_phone_ck" CHECK ("candidates"."phone" is null or length("candidates"."phone") <= 40),
	CONSTRAINT "candidates_source_ck" CHECK ("candidates"."source" in ('referral','job_board','website','agency','walk_in','other')),
	CONSTRAINT "candidates_tags_ck" CHECK (cardinality("candidates"."tags") <= 10),
	CONSTRAINT "candidates_notes_ck" CHECK (length("candidates"."notes") <= 2000),
	CONSTRAINT "candidates_resume_ck" CHECK (("candidates"."resume_key" is null) = ("candidates"."resume_name" is null) and ("candidates"."resume_key" is null) = ("candidates"."resume_size" is null))
);
--> statement-breakpoint
CREATE TABLE "job_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"department_id" uuid,
	"designation_id" uuid,
	"headcount" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "job_openings_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_openings_title_ck" CHECK (length(trim("job_openings"."title")) between 1 and 120),
	CONSTRAINT "job_openings_headcount_ck" CHECK ("job_openings"."headcount" between 1 and 500),
	CONSTRAINT "job_openings_status_ck" CHECK ("job_openings"."status" in ('open','on_hold','closed')),
	CONSTRAINT "job_openings_description_ck" CHECK (length("job_openings"."description") <= 5000)
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" smallint NOT NULL,
	"kind" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "pipeline_stages_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pipeline_stages_name_uq" UNIQUE("tenant_id","opening_id","name"),
	CONSTRAINT "pipeline_stages_order_uq" UNIQUE("tenant_id","opening_id","sort_order"),
	CONSTRAINT "pipeline_stages_name_ck" CHECK (length(trim("pipeline_stages"."name")) between 1 and 40),
	CONSTRAINT "pipeline_stages_kind_ck" CHECK ("pipeline_stages"."kind" in ('active','hired','rejected'))
);
--> statement-breakpoint
ALTER TABLE "candidate_stage_history" ADD CONSTRAINT "candidate_stage_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_stage_history" ADD CONSTRAINT "candidate_stage_history_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_stage_history" ADD CONSTRAINT "candidate_stage_history_from_fk" FOREIGN KEY ("tenant_id","from_stage_id") REFERENCES "public"."pipeline_stages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_stage_history" ADD CONSTRAINT "candidate_stage_history_to_fk" FOREIGN KEY ("tenant_id","to_stage_id") REFERENCES "public"."pipeline_stages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_opening_fk" FOREIGN KEY ("tenant_id","opening_id") REFERENCES "public"."job_openings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_stage_fk" FOREIGN KEY ("tenant_id","stage_id") REFERENCES "public"."pipeline_stages"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_designation_fk" FOREIGN KEY ("tenant_id","designation_id") REFERENCES "public"."designations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_opening_fk" FOREIGN KEY ("tenant_id","opening_id") REFERENCES "public"."job_openings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_stage_history_candidate_idx" ON "candidate_stage_history" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE INDEX "candidates_opening_idx" ON "candidates" USING btree ("tenant_id","opening_id","stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_email_uq" ON "candidates" USING btree ("tenant_id","opening_id","email") WHERE "candidates"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_employee_uq" ON "candidates" USING btree ("tenant_id","employee_id") WHERE "candidates"."employee_id" is not null;--> statement-breakpoint
CREATE INDEX "job_openings_status_idx" ON "job_openings" USING btree ("tenant_id","status");