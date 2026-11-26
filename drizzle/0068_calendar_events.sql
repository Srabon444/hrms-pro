CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "calendar_feeds_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_feeds_hash_ck" CHECK ("calendar_feeds"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "event_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"response" text NOT NULL,
	CONSTRAINT "event_rsvps_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "event_rsvps_response_ck" CHECK ("event_rsvps"."response" in ('yes','no','maybe'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"audience" text DEFAULT 'all' NOT NULL,
	"department_id" uuid,
	"branch_id" uuid,
	"created_by_user_id" uuid,
	CONSTRAINT "events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "events_title_ck" CHECK (length(trim("events"."title")) between 1 and 160),
	CONSTRAINT "events_description_ck" CHECK (length("events"."description") <= 2000),
	CONSTRAINT "events_location_ck" CHECK (length("events"."location") <= 200),
	CONSTRAINT "events_span_ck" CHECK ("events"."end_date" >= "events"."start_date" and "events"."end_date" - "events"."start_date" <= 31),
	CONSTRAINT "events_times_ck" CHECK (("events"."start_time" is null and "events"."end_time" is null) or ("events"."start_time" is not null and "events"."end_time" is not null and ("events"."end_date" > "events"."start_date" or "events"."end_time" > "events"."start_time"))),
	CONSTRAINT "events_audience_ck" CHECK (("events"."audience" = 'all' and "events"."department_id" is null and "events"."branch_id" is null) or ("events"."audience" = 'department' and "events"."department_id" is not null and "events"."branch_id" is null) or ("events"."audience" = 'branch' and "events"."branch_id" is not null and "events"."department_id" is null))
);
--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."events"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_token_uq" ON "calendar_feeds" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feeds_active_uq" ON "calendar_feeds" USING btree ("tenant_id","membership_id") WHERE "calendar_feeds"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "event_rsvps_member_uq" ON "event_rsvps" USING btree ("tenant_id","event_id","membership_id");--> statement-breakpoint
CREATE INDEX "events_dates_idx" ON "events" USING btree ("tenant_id","start_date","end_date");