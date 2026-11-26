CREATE TABLE "member_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid NOT NULL,
	"pdf_password_enc" text NOT NULL,
	CONSTRAINT "member_secrets_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "payslip_email_pdf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "member_secrets" ADD CONSTRAINT "member_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_secrets" ADD CONSTRAINT "member_secrets_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_secrets_membership_uq" ON "member_secrets" USING btree ("tenant_id","membership_id");