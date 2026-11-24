CREATE TABLE "checklist_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_role" text NOT NULL,
	"due_offset_days" smallint NOT NULL,
	CONSTRAINT "checklist_template_items_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "checklist_template_items_title_ck" CHECK (length("checklist_template_items"."title") between 1 and 200),
	CONSTRAINT "checklist_template_items_offset_ck" CHECK ("checklist_template_items"."due_offset_days" between -90 and 365)
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "checklist_templates_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "checklist_templates_name_uq" UNIQUE("tenant_id","kind","name"),
	CONSTRAINT "checklist_templates_kind_ck" CHECK ("checklist_templates"."kind" in ('onboarding','offboarding')),
	CONSTRAINT "checklist_templates_name_ck" CHECK (length("checklist_templates"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."checklist_templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_template_items_template_idx" ON "checklist_template_items" USING btree ("tenant_id","template_id");