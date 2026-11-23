CREATE TABLE "checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_role" text NOT NULL,
	"due_date" date NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	CONSTRAINT "checklist_items_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"anchor_date" date NOT NULL,
	CONSTRAINT "checklists_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "checklists_once_uq" UNIQUE("tenant_id","employee_id","template_id","anchor_date"),
	CONSTRAINT "checklists_kind_ck" CHECK ("checklists"."kind" in ('onboarding','offboarding'))
);
--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklist_fk" FOREIGN KEY ("tenant_id","checklist_id") REFERENCES "public"."checklists"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."checklist_templates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_items_checklist_idx" ON "checklist_items" USING btree ("tenant_id","checklist_id");--> statement-breakpoint
CREATE INDEX "checklist_items_open_idx" ON "checklist_items" USING btree ("tenant_id","assignee_role","due_date") WHERE "checklist_items"."done_at" is null;