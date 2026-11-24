CREATE TABLE "interview_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interview_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"rating" smallint,
	"recommendation" text,
	"comments" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "interview_feedback_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "interview_feedback_uq" UNIQUE("tenant_id","interview_id","membership_id"),
	CONSTRAINT "interview_feedback_rating_ck" CHECK ("interview_feedback"."rating" is null or "interview_feedback"."rating" between 1 and 5),
	CONSTRAINT "interview_feedback_recommendation_ck" CHECK ("interview_feedback"."recommendation" is null or "interview_feedback"."recommendation" in ('strong_no','no','yes','strong_yes')),
	CONSTRAINT "interview_feedback_comments_ck" CHECK (length("interview_feedback"."comments") <= 2000),
	CONSTRAINT "interview_feedback_submitted_ck" CHECK (("interview_feedback"."submitted_at" is null) = ("interview_feedback"."rating" is null) and ("interview_feedback"."submitted_at" is null) = ("interview_feedback"."recommendation" is null))
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "interviews_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "interviews_title_ck" CHECK (length(trim("interviews"."title")) between 1 and 80),
	CONSTRAINT "interviews_duration_ck" CHECK ("interviews"."duration_minutes" between 15 and 480),
	CONSTRAINT "interviews_location_ck" CHECK (length("interviews"."location") <= 300),
	CONSTRAINT "interviews_status_ck" CHECK ("interviews"."status" in ('scheduled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"monthly_gross" integer NOT NULL,
	"join_date" date NOT NULL,
	"expires_on" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "offers_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "offers_gross_ck" CHECK ("offers"."monthly_gross" > 0),
	CONSTRAINT "offers_status_ck" CHECK ("offers"."status" in ('pending','accepted','declined','withdrawn')),
	CONSTRAINT "offers_note_ck" CHECK (length("offers"."note") <= 500),
	CONSTRAINT "offers_expiry_ck" CHECK ("offers"."expires_on" is null or "offers"."expires_on" <= "offers"."join_date"),
	CONSTRAINT "offers_decided_ck" CHECK (("offers"."status" = 'pending') = ("offers"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_interview_fk" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_feedback_member_idx" ON "interview_feedback" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "interviews_candidate_idx" ON "interviews" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_live_uq" ON "offers" USING btree ("tenant_id","candidate_id") WHERE "offers"."status" in ('pending','accepted');