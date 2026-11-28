CREATE TABLE "employee_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"validated_by_user_id" uuid,
	"validated_at" timestamp with time zone,
	CONSTRAINT "employee_skills_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_skills_uq" UNIQUE("tenant_id","employee_id","skill_id"),
	CONSTRAINT "employee_skills_level_ck" CHECK ("employee_skills"."level" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "opening_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "opening_skills_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "opening_skills_uq" UNIQUE("tenant_id","opening_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"hired_employee_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_on" date NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" uuid,
	CONSTRAINT "referral_rewards_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "referral_rewards_candidate_uq" UNIQUE("tenant_id","candidate_id"),
	CONSTRAINT "referral_rewards_amount_ck" CHECK ("referral_rewards"."amount" between 1 and 100000000),
	CONSTRAINT "referral_rewards_status_ck" CHECK ("referral_rewards"."status" in ('pending','due','paid','void'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" "citext" NOT NULL,
	CONSTRAINT "skills_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "skills_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "skills_name_ck" CHECK (length(trim("skills"."name")) between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT "candidates_source_ck";--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "referral_qualify_days" smallint DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "internal_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "referred_by_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "job_openings" ADD COLUMN "visibility" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_openings" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "job_openings" ADD COLUMN "referral_bonus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_skill_fk" FOREIGN KEY ("tenant_id","skill_id") REFERENCES "public"."skills"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_skills" ADD CONSTRAINT "opening_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_skills" ADD CONSTRAINT "opening_skills_opening_fk" FOREIGN KEY ("tenant_id","opening_id") REFERENCES "public"."job_openings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_skills" ADD CONSTRAINT "opening_skills_skill_fk" FOREIGN KEY ("tenant_id","skill_id") REFERENCES "public"."skills"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_hired_fk" FOREIGN KEY ("tenant_id","hired_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_skills_skill_idx" ON "employee_skills" USING btree ("tenant_id","skill_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_status_idx" ON "referral_rewards" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_internal_fk" FOREIGN KEY ("tenant_id","internal_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_referrer_fk" FOREIGN KEY ("tenant_id","referred_by_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_internal_uq" ON "candidates" USING btree ("tenant_id","opening_id","internal_employee_id") WHERE "candidates"."internal_employee_id" is not null;--> statement-breakpoint
CREATE INDEX "candidates_referrer_idx" ON "candidates" USING btree ("tenant_id","referred_by_employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_openings_public_slug_uq" ON "job_openings" USING btree ("tenant_id","public_slug") WHERE "job_openings"."public_slug" is not null;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_referral_qualify_days_ck" CHECK ("tenant_settings"."referral_qualify_days" between 1 and 730);--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_source_ck" CHECK ("candidates"."source" in ('referral','job_board','website','agency','walk_in','internal','other'));--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_visibility_ck" CHECK ("job_openings"."visibility" in ('none','internal','public','both'));--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_public_slug_ck" CHECK ("job_openings"."public_slug" is null or "job_openings"."public_slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$');--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_referral_bonus_ck" CHECK ("job_openings"."referral_bonus" between 0 and 100000000);