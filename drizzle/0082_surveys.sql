CREATE TABLE "survey_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"anonymous" boolean NOT NULL,
	"question_id" uuid NOT NULL,
	"value_num" smallint,
	"value_text" text,
	"slice_department_id" uuid,
	"slice_branch_id" uuid,
	"membership_id" uuid,
	"batch" integer,
	CONSTRAINT "survey_answers_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey_answers_person_ck" CHECK ("survey_answers"."anonymous" = ("survey_answers"."membership_id" is null)),
	CONSTRAINT "survey_answers_value_ck" CHECK (("survey_answers"."value_num" is not null) <> ("survey_answers"."value_text" is not null) and ("survey_answers"."value_text" is null or length("survey_answers"."value_text") between 1 and 2000))
);
--> statement-breakpoint
CREATE TABLE "survey_participation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	CONSTRAINT "survey_participation_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "survey_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"survey_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "survey_questions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey_questions_survey_uq" UNIQUE("tenant_id","survey_id","id"),
	CONSTRAINT "survey_questions_kind_ck" CHECK ("survey_questions"."kind" in ('scale', 'enps', 'choice', 'text')),
	CONSTRAINT "survey_questions_prompt_ck" CHECK (length(trim("survey_questions"."prompt")) between 1 and 300),
	CONSTRAINT "survey_questions_position_ck" CHECK ("survey_questions"."position" between 0 and 19),
	CONSTRAINT "survey_questions_options_ck" CHECK (("survey_questions"."kind" = 'choice' and cardinality("survey_questions"."options") between 2 and 10) or ("survey_questions"."kind" <> 'choice' and cardinality("survey_questions"."options") = 0))
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'pulse' NOT NULL,
	"title" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"department_id" uuid,
	"branch_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"closes_on" date,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"min_group_size" smallint DEFAULT 5 NOT NULL,
	"reminders_sent" smallint DEFAULT 0 NOT NULL,
	"released_batches" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "surveys_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "surveys_anonymous_uq" UNIQUE("tenant_id","id","anonymous"),
	CONSTRAINT "surveys_kind_ck" CHECK ("surveys"."kind" in ('pulse', 'suggestion')),
	CONSTRAINT "surveys_status_ck" CHECK ("surveys"."status" in ('draft', 'open', 'closed')),
	CONSTRAINT "surveys_title_ck" CHECK (length(trim("surveys"."title")) between 1 and 160),
	CONSTRAINT "surveys_intro_ck" CHECK (length("surveys"."intro") <= 2000),
	CONSTRAINT "surveys_min_group_ck" CHECK ("surveys"."min_group_size" between 5 and 50),
	CONSTRAINT "surveys_reminders_ck" CHECK ("surveys"."reminders_sent" between 0 and 2),
	CONSTRAINT "surveys_suggestion_ck" CHECK ("surveys"."kind" = 'pulse' or ("surveys"."anonymous" and "surveys"."audience" = 'all' and "surveys"."closes_on" is null)),
	CONSTRAINT "surveys_closes_ck" CHECK ("surveys"."kind" = 'suggestion' or "surveys"."status" = 'draft' or "surveys"."closes_on" is not null),
	CONSTRAINT "surveys_audience_ck" CHECK (("surveys"."audience" = 'all' and "surveys"."department_id" is null and "surveys"."branch_id" is null) or ("surveys"."audience" = 'department' and "surveys"."department_id" is not null and "surveys"."branch_id" is null) or ("surveys"."audience" = 'branch' and "surveys"."branch_id" is not null and "surveys"."department_id" is null))
);
--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_survey_fk" FOREIGN KEY ("tenant_id","survey_id","anonymous") REFERENCES "public"."surveys"("tenant_id","id","anonymous") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_question_fk" FOREIGN KEY ("tenant_id","survey_id","question_id") REFERENCES "public"."survey_questions"("tenant_id","survey_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participation" ADD CONSTRAINT "survey_participation_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participation" ADD CONSTRAINT "survey_participation_survey_fk" FOREIGN KEY ("tenant_id","survey_id") REFERENCES "public"."surveys"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participation" ADD CONSTRAINT "survey_participation_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_survey_fk" FOREIGN KEY ("tenant_id","survey_id") REFERENCES "public"."surveys"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey_answers_survey_idx" ON "survey_answers" USING btree ("tenant_id","survey_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "survey_participation_member_uq" ON "survey_participation" USING btree ("tenant_id","survey_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "survey_questions_position_uq" ON "survey_questions" USING btree ("tenant_id","survey_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "surveys_suggestion_uq" ON "surveys" USING btree ("tenant_id") WHERE "surveys"."kind" = 'suggestion';