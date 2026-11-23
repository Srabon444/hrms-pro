CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"weight" smallint NOT NULL,
	"actual" text DEFAULT '' NOT NULL,
	"self_rating" smallint,
	"manager_rating" smallint,
	CONSTRAINT "goals_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "goals_title_ck" CHECK (length(trim("goals"."title")) between 1 and 120),
	CONSTRAINT "goals_text_ck" CHECK (length("goals"."target") <= 200 and length("goals"."actual") <= 200),
	CONSTRAINT "goals_weight_ck" CHECK ("goals"."weight" between 1 and 100),
	CONSTRAINT "goals_rating_ck" CHECK ("goals"."self_rating" between 1 and 5 and "goals"."manager_rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "review_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "review_cycles_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "review_cycles_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "review_cycles_name_ck" CHECK (length(trim("review_cycles"."name")) between 1 and 80),
	CONSTRAINT "review_cycles_period_ck" CHECK ("review_cycles"."period_end" >= "review_cycles"."period_start"),
	CONSTRAINT "review_cycles_status_ck" CHECK ("review_cycles"."status" in ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"stage" text DEFAULT 'self' NOT NULL,
	"self_comments" text DEFAULT '' NOT NULL,
	"manager_comments" text DEFAULT '' NOT NULL,
	"score" smallint,
	"shared" boolean DEFAULT false NOT NULL,
	"self_submitted_at" timestamp with time zone,
	"manager_submitted_at" timestamp with time zone,
	"manager_user_id" uuid,
	"finalised_at" timestamp with time zone,
	"finalised_by_user_id" uuid,
	CONSTRAINT "reviews_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "reviews_cycle_employee_uq" UNIQUE("tenant_id","cycle_id","employee_id"),
	CONSTRAINT "reviews_stage_ck" CHECK ("reviews"."stage" in ('self','manager','hr','done')),
	CONSTRAINT "reviews_comments_ck" CHECK (length("reviews"."self_comments") <= 4000 and length("reviews"."manager_comments") <= 4000),
	CONSTRAINT "reviews_score_ck" CHECK ("reviews"."score" between 100 and 500),
	CONSTRAINT "reviews_self_ck" CHECK (("reviews"."stage" = 'self') = ("reviews"."self_submitted_at" is null)),
	CONSTRAINT "reviews_manager_ck" CHECK (("reviews"."stage" in ('hr','done')) = ("reviews"."manager_submitted_at" is not null)),
	CONSTRAINT "reviews_score_set_ck" CHECK (("reviews"."stage" in ('hr','done')) = ("reviews"."score" is not null)),
	CONSTRAINT "reviews_final_ck" CHECK (("reviews"."stage" = 'done') = ("reviews"."finalised_at" is not null)),
	CONSTRAINT "reviews_shared_ck" CHECK (not "reviews"."shared" or "reviews"."stage" = 'done')
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_review_fk" FOREIGN KEY ("tenant_id","review_id") REFERENCES "public"."reviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_cycle_fk" FOREIGN KEY ("tenant_id","cycle_id") REFERENCES "public"."review_cycles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_review_idx" ON "goals" USING btree ("tenant_id","review_id");--> statement-breakpoint
CREATE INDEX "reviews_employee_idx" ON "reviews" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "reviews_stage_idx" ON "reviews" USING btree ("tenant_id","stage");