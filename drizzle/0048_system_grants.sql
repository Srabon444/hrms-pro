CREATE TABLE "system_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role_key" text NOT NULL,
	"permission" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "system_grants_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "system_grants_uq" UNIQUE("tenant_id","role_key","permission","scope")
);
--> statement-breakpoint
ALTER TABLE "system_grants" ADD CONSTRAINT "system_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;