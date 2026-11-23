CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"department_id" uuid,
	"branch_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"publish_on" date NOT NULL,
	"expires_on" date,
	"created_by_user_id" uuid,
	CONSTRAINT "announcements_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "announcements_title_ck" CHECK (length(trim("announcements"."title")) between 1 and 160),
	CONSTRAINT "announcements_body_ck" CHECK (length(trim("announcements"."body")) between 1 and 5000),
	CONSTRAINT "announcements_audience_ck" CHECK (("announcements"."audience" = 'all' and "announcements"."department_id" is null and "announcements"."branch_id" is null) or ("announcements"."audience" = 'department' and "announcements"."department_id" is not null and "announcements"."branch_id" is null) or ("announcements"."audience" = 'branch' and "announcements"."branch_id" is not null and "announcements"."department_id" is null)),
	CONSTRAINT "announcements_window_ck" CHECK ("announcements"."expires_on" >= "announcements"."publish_on")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_publish_idx" ON "announcements" USING btree ("tenant_id","publish_on");