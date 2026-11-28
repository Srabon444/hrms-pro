CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_membership_id" uuid,
	"to_employee_id" uuid NOT NULL,
	"text" text NOT NULL,
	"visibility" text NOT NULL,
	CONSTRAINT "feedback_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "feedback_text_ck" CHECK (length("feedback"."text") between 1 and 2000),
	CONSTRAINT "feedback_visibility_ck" CHECK ("feedback"."visibility" in ('manager_only','shared'))
);
--> statement-breakpoint
CREATE TABLE "feedback_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requester_membership_id" uuid NOT NULL,
	"about_employee_id" uuid NOT NULL,
	"asked_membership_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "feedback_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "feedback_requests_note_ck" CHECK (length("feedback_requests"."note") <= 500),
	CONSTRAINT "feedback_requests_status_ck" CHECK ("feedback_requests"."status" in ('open','answered','declined'))
);
--> statement-breakpoint
CREATE TABLE "one_on_one_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"owner_employee_id" uuid,
	"done_at" timestamp with time zone,
	CONSTRAINT "one_on_one_items_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "one_on_one_items_kind_ck" CHECK ("one_on_one_items"."kind" in ('agenda','action')),
	CONSTRAINT "one_on_one_items_text_ck" CHECK (length("one_on_one_items"."text") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "one_on_one_private_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"author_membership_id" uuid NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "one_on_one_private_notes_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "one_on_one_private_notes_text_ck" CHECK (length("one_on_one_private_notes"."text") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "one_on_ones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"manager_employee_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"scheduled_for" date NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	CONSTRAINT "one_on_ones_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "one_on_ones_pair_ck" CHECK ("one_on_ones"."manager_employee_id" <> "one_on_ones"."employee_id"),
	CONSTRAINT "one_on_ones_status_ck" CHECK ("one_on_ones"."status" in ('scheduled','done','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_from_fk" FOREIGN KEY ("tenant_id","from_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_to_fk" FOREIGN KEY ("tenant_id","to_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_requester_fk" FOREIGN KEY ("tenant_id","requester_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_about_fk" FOREIGN KEY ("tenant_id","about_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_asked_fk" FOREIGN KEY ("tenant_id","asked_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_items" ADD CONSTRAINT "one_on_one_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_items" ADD CONSTRAINT "one_on_one_items_meeting_fk" FOREIGN KEY ("tenant_id","meeting_id") REFERENCES "public"."one_on_ones"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_items" ADD CONSTRAINT "one_on_one_items_owner_fk" FOREIGN KEY ("tenant_id","owner_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_private_notes" ADD CONSTRAINT "one_on_one_private_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_private_notes" ADD CONSTRAINT "one_on_one_private_notes_meeting_fk" FOREIGN KEY ("tenant_id","meeting_id") REFERENCES "public"."one_on_ones"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_private_notes" ADD CONSTRAINT "one_on_one_private_notes_author_fk" FOREIGN KEY ("tenant_id","author_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_ones" ADD CONSTRAINT "one_on_ones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_ones" ADD CONSTRAINT "one_on_ones_manager_fk" FOREIGN KEY ("tenant_id","manager_employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_ones" ADD CONSTRAINT "one_on_ones_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_to_idx" ON "feedback" USING btree ("tenant_id","to_employee_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_from_idx" ON "feedback" USING btree ("tenant_id","from_membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_requests_open_uq" ON "feedback_requests" USING btree ("tenant_id","requester_membership_id","asked_membership_id") WHERE "feedback_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "feedback_requests_asked_idx" ON "feedback_requests" USING btree ("tenant_id","asked_membership_id","status");--> statement-breakpoint
CREATE INDEX "feedback_requests_requester_idx" ON "feedback_requests" USING btree ("tenant_id","requester_membership_id");--> statement-breakpoint
CREATE INDEX "one_on_one_items_meeting_idx" ON "one_on_one_items" USING btree ("tenant_id","meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_on_one_private_notes_uq" ON "one_on_one_private_notes" USING btree ("tenant_id","meeting_id","author_membership_id");--> statement-breakpoint
CREATE INDEX "one_on_one_private_notes_author_idx" ON "one_on_one_private_notes" USING btree ("tenant_id","author_membership_id");--> statement-breakpoint
CREATE INDEX "one_on_ones_employee_idx" ON "one_on_ones" USING btree ("tenant_id","employee_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "one_on_ones_manager_idx" ON "one_on_ones" USING btree ("tenant_id","manager_employee_id","scheduled_for");