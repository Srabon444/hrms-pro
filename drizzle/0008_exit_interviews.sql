CREATE TABLE "exit_interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"exit_date" date NOT NULL,
	"primary_reason" text NOT NULL,
	"rating" smallint NOT NULL,
	"would_recommend" boolean NOT NULL,
	"would_rejoin" boolean NOT NULL,
	"comments" text,
	"submitted_by_user_id" uuid NOT NULL,
	CONSTRAINT "exit_interviews_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "exit_interviews_one_uq" UNIQUE("tenant_id","employee_id","exit_date"),
	CONSTRAINT "exit_interviews_reason_ck" CHECK ("exit_interviews"."primary_reason" in ('compensation','growth','management','work_life','relocation','studies','health','other')),
	CONSTRAINT "exit_interviews_rating_ck" CHECK ("exit_interviews"."rating" between 1 and 5),
	CONSTRAINT "exit_interviews_comments_ck" CHECK ("exit_interviews"."comments" is null or length("exit_interviews"."comments") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "exit_interviews" ADD CONSTRAINT "exit_interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_interviews" ADD CONSTRAINT "exit_interviews_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;