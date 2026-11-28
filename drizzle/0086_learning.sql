CREATE TABLE "certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text DEFAULT '' NOT NULL,
	"issued_on" date NOT NULL,
	"expires_on" date,
	"added_by_user_id" uuid,
	CONSTRAINT "certifications_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "certifications_name_ck" CHECK (length(trim("certifications"."name")) between 1 and 160),
	CONSTRAINT "certifications_issuer_ck" CHECK (length("certifications"."issuer") <= 160),
	CONSTRAINT "certifications_dates_ck" CHECK ("certifications"."expires_on" is null or "certifications"."expires_on" >= "certifications"."issued_on")
);
--> statement-breakpoint
CREATE TABLE "course_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"course_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"department_id" uuid,
	"branch_id" uuid,
	"employee_id" uuid,
	"due_in_days" smallint NOT NULL,
	"mandatory" boolean DEFAULT true NOT NULL,
	"renew_every_months" smallint,
	"created_by_user_id" uuid,
	CONSTRAINT "course_assignments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "course_assignments_audience_ck" CHECK ("course_assignments"."audience" in ('all','department','branch','employee')),
	CONSTRAINT "course_assignments_target_ck" CHECK (("course_assignments"."department_id" is not null) = ("course_assignments"."audience" = 'department') and ("course_assignments"."branch_id" is not null) = ("course_assignments"."audience" = 'branch') and ("course_assignments"."employee_id" is not null) = ("course_assignments"."audience" = 'employee')),
	CONSTRAINT "course_assignments_due_ck" CHECK ("course_assignments"."due_in_days" between 1 and 365),
	CONSTRAINT "course_assignments_renew_ck" CHECK ("course_assignments"."renew_every_months" is null or "course_assignments"."renew_every_months" between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "course_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"course_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"assignment_id" uuid,
	"cycle" smallint DEFAULT 1 NOT NULL,
	"due_on" date,
	"mandatory" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"score" smallint,
	"completed_at" timestamp with time zone,
	"expires_on" date,
	"certificate_code" text,
	CONSTRAINT "course_enrolments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "course_enrolments_uq" UNIQUE("tenant_id","course_id","employee_id","cycle"),
	CONSTRAINT "course_enrolments_code_uq" UNIQUE("tenant_id","certificate_code"),
	CONSTRAINT "course_enrolments_status_ck" CHECK ("course_enrolments"."status" in ('assigned','passed','failed')),
	CONSTRAINT "course_enrolments_score_ck" CHECK ("course_enrolments"."score" is null or "course_enrolments"."score" between 0 and 100),
	CONSTRAINT "course_enrolments_cycle_ck" CHECK ("course_enrolments"."cycle" between 1 and 1000),
	CONSTRAINT "course_enrolments_passed_ck" CHECK (("course_enrolments"."status" = 'passed') = ("course_enrolments"."completed_at" is not null and "course_enrolments"."certificate_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "course_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"course_id" uuid NOT NULL,
	"sort_order" smallint NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"url" text,
	CONSTRAINT "course_lessons_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "course_lessons_kind_ck" CHECK ("course_lessons"."kind" in ('text','link','file','quiz')),
	CONSTRAINT "course_lessons_title_ck" CHECK (length(trim("course_lessons"."title")) between 1 and 160),
	CONSTRAINT "course_lessons_body_ck" CHECK (length("course_lessons"."body") <= 20000),
	CONSTRAINT "course_lessons_url_ck" CHECK (("course_lessons"."kind" = 'link') = ("course_lessons"."url" is not null) and ("course_lessons"."url" is null or ("course_lessons"."url" ~ '^https?://' and length("course_lessons"."url") <= 2000)))
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"pass_mark" smallint DEFAULT 70 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "courses_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "courses_title_ck" CHECK (length(trim("courses"."title")) between 1 and 160),
	CONSTRAINT "courses_description_ck" CHECK (length("courses"."description") <= 5000),
	CONSTRAINT "courses_pass_mark_ck" CHECK ("courses"."pass_mark" between 1 and 100),
	CONSTRAINT "courses_max_attempts_ck" CHECK ("courses"."max_attempts" between 1 and 10),
	CONSTRAINT "courses_status_ck" CHECK ("courses"."status" in ('draft','published','archived'))
);
--> statement-breakpoint
CREATE TABLE "lesson_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"score" smallint,
	"completed_at" timestamp with time zone,
	CONSTRAINT "lesson_progress_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "lesson_progress_uq" UNIQUE("tenant_id","enrolment_id","lesson_id"),
	CONSTRAINT "lesson_progress_attempts_ck" CHECK ("lesson_progress"."attempts" between 0 and 100),
	CONSTRAINT "lesson_progress_score_ck" CHECK ("lesson_progress"."score" is null or "lesson_progress"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"sort_order" smallint NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer_ids" text[] NOT NULL,
	CONSTRAINT "quiz_questions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "quiz_questions_prompt_ck" CHECK (length(trim("quiz_questions"."prompt")) between 1 and 500),
	CONSTRAINT "quiz_questions_options_ck" CHECK (jsonb_array_length("quiz_questions"."options") between 2 and 8),
	CONSTRAINT "quiz_questions_answers_ck" CHECK (cardinality("quiz_questions"."answer_ids") >= 1)
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_owner_type_ck";--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_course_fk" FOREIGN KEY ("tenant_id","course_id") REFERENCES "public"."courses"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_course_fk" FOREIGN KEY ("tenant_id","course_id") REFERENCES "public"."courses"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrolments" ADD CONSTRAINT "course_enrolments_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "public"."course_assignments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_course_fk" FOREIGN KEY ("tenant_id","course_id") REFERENCES "public"."courses"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrolment_fk" FOREIGN KEY ("tenant_id","enrolment_id") REFERENCES "public"."course_enrolments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_fk" FOREIGN KEY ("tenant_id","lesson_id") REFERENCES "public"."course_lessons"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_lesson_fk" FOREIGN KEY ("tenant_id","lesson_id") REFERENCES "public"."course_lessons"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certifications_employee_idx" ON "certifications" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "certifications_expiry_idx" ON "certifications" USING btree ("tenant_id","expires_on");--> statement-breakpoint
CREATE INDEX "course_assignments_course_idx" ON "course_assignments" USING btree ("tenant_id","course_id");--> statement-breakpoint
CREATE INDEX "course_enrolments_employee_idx" ON "course_enrolments" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "course_enrolments_due_idx" ON "course_enrolments" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE INDEX "course_enrolments_assignment_idx" ON "course_enrolments" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE INDEX "course_lessons_course_idx" ON "course_lessons" USING btree ("tenant_id","course_id","sort_order");--> statement-breakpoint
CREATE INDEX "courses_status_idx" ON "courses" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "quiz_questions_lesson_idx" ON "quiz_questions" USING btree ("tenant_id","lesson_id","sort_order");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_type_ck" CHECK ("files"."owner_type" in ('leave_request','ticket','resignation','asset','candidate','offer','interview_feedback','checklist_item','change_request','attendance_request','loan','ticket_comment','announcement','salary_change','review','goal','project','meal_bill','education','experience','course_lesson','certification'));