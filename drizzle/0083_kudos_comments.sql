CREATE TABLE "announcement_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announcement_id" uuid NOT NULL,
	"author_membership_id" uuid,
	"body" text NOT NULL,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"hidden_by_user_id" uuid,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "announcement_comments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "announcement_comments_body_ck" CHECK (length("announcement_comments"."body") between 1 and 2000),
	CONSTRAINT "announcement_comments_mentions_ck" CHECK (cardinality("announcement_comments"."mentions") <= 10)
);
--> statement-breakpoint
CREATE TABLE "announcement_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "announcement_reactions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "announcement_reactions_kind_ck" CHECK ("announcement_reactions"."kind" in ('like', 'love', 'celebrate', 'insightful', 'funny', 'support'))
);
--> statement-breakpoint
CREATE TABLE "kudos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_membership_id" uuid,
	"message" text NOT NULL,
	"value_tag" text,
	"hidden_by_user_id" uuid,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "kudos_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "kudos_message_ck" CHECK (length("kudos"."message") between 1 and 500),
	CONSTRAINT "kudos_value_ck" CHECK ("kudos"."value_tag" is null or length("kudos"."value_tag") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "kudos_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kudos_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	CONSTRAINT "kudos_recipients_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "kudos_values" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_comments" ADD CONSTRAINT "announcement_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_comments" ADD CONSTRAINT "announcement_comments_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_comments" ADD CONSTRAINT "announcement_comments_author_fk" FOREIGN KEY ("tenant_id","author_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reactions" ADD CONSTRAINT "announcement_reactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reactions" ADD CONSTRAINT "announcement_reactions_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reactions" ADD CONSTRAINT "announcement_reactions_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_from_fk" FOREIGN KEY ("tenant_id","from_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos_recipients" ADD CONSTRAINT "kudos_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos_recipients" ADD CONSTRAINT "kudos_recipients_kudos_fk" FOREIGN KEY ("tenant_id","kudos_id") REFERENCES "public"."kudos"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos_recipients" ADD CONSTRAINT "kudos_recipients_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_comments_thread_idx" ON "announcement_comments" USING btree ("tenant_id","announcement_id","created_at");--> statement-breakpoint
CREATE INDEX "announcement_comments_author_idx" ON "announcement_comments" USING btree ("tenant_id","author_membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "announcement_reactions_uq" ON "announcement_reactions" USING btree ("tenant_id","announcement_id","membership_id","kind");--> statement-breakpoint
CREATE INDEX "announcement_reactions_member_idx" ON "announcement_reactions" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "kudos_created_idx" ON "kudos" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kudos_recipients_uq" ON "kudos_recipients" USING btree ("tenant_id","kudos_id","membership_id");--> statement-breakpoint
CREATE INDEX "kudos_recipients_member_idx" ON "kudos_recipients" USING btree ("tenant_id","membership_id");