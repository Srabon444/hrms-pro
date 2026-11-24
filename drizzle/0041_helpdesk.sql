CREATE TABLE "ticket_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" "citext" NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"sla_hours" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ticket_categories_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ticket_categories_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "ticket_categories_name_ck" CHECK (length(trim("ticket_categories"."name")) between 1 and 60),
	CONSTRAINT "ticket_categories_sla_ck" CHECK ("ticket_categories"."sla_hours" between 1 and 720)
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_membership_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ticket_comments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ticket_comments_body_ck" CHECK (length(trim("ticket_comments"."body")) between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"category_id" uuid NOT NULL,
	"requester_employee_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_membership_id" uuid,
	"sla_due_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "tickets_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tickets_number_uq" UNIQUE("tenant_id","number"),
	CONSTRAINT "tickets_number_ck" CHECK ("tickets"."number" > 0),
	CONSTRAINT "tickets_subject_ck" CHECK (length(trim("tickets"."subject")) between 1 and 160),
	CONSTRAINT "tickets_description_ck" CHECK (length(trim("tickets"."description")) between 1 and 5000),
	CONSTRAINT "tickets_priority_ck" CHECK ("tickets"."priority" in ('low','normal','high','urgent')),
	CONSTRAINT "tickets_status_ck" CHECK ("tickets"."status" in ('open','in_progress','waiting','resolved','closed')),
	CONSTRAINT "tickets_resolved_ck" CHECK (("tickets"."status" in ('resolved','closed')) = ("tickets"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_fk" FOREIGN KEY ("tenant_id","author_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."ticket_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_fk" FOREIGN KEY ("tenant_id","requester_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_fk" FOREIGN KEY ("tenant_id","assignee_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_idx" ON "ticket_comments" USING btree ("tenant_id","ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "tickets_requester_idx" ON "tickets" USING btree ("tenant_id","requester_employee_id");