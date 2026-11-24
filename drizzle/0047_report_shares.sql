CREATE TABLE "report_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"report_id" text NOT NULL,
	"title" text NOT NULL,
	"period" text NOT NULL,
	"spec" jsonb NOT NULL,
	"storage_key" text NOT NULL,
	"recipient_membership_ids" uuid[] NOT NULL,
	"shared_by_membership_id" uuid NOT NULL,
	"shared_by_user_id" uuid,
	"expires_on" date NOT NULL,
	CONSTRAINT "report_shares_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_shares_recipients_ck" CHECK (cardinality("report_shares"."recipient_membership_ids") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_sharer_fk" FOREIGN KEY ("tenant_id","shared_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_shares_created_idx" ON "report_shares" USING btree ("tenant_id","created_at");