CREATE TABLE "work_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"description" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"carried_over_from_id" uuid,
	"created_by_user_id" uuid,
	CONSTRAINT "work_plan_items_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "work_plan_items_description_ck" CHECK (length(trim("work_plan_items"."description")) between 1 and 300),
	CONSTRAINT "work_plan_items_target_ck" CHECK (length("work_plan_items"."target") <= 120),
	CONSTRAINT "work_plan_items_status_ck" CHECK ("work_plan_items"."status" in ('pending','in_progress','done'))
);
--> statement-breakpoint
ALTER TABLE "work_plan_items" ADD CONSTRAINT "work_plan_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_plan_items" ADD CONSTRAINT "work_plan_items_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_plan_items_week_idx" ON "work_plan_items" USING btree ("tenant_id","week_start","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_plan_items_carried_uq" ON "work_plan_items" USING btree ("tenant_id","carried_over_from_id") WHERE "work_plan_items"."carried_over_from_id" is not null;