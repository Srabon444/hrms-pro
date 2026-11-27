CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"grants" jsonb NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "api_keys_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "api_keys_name_ck" CHECK (length(trim("api_keys"."name")) between 1 and 60),
	CONSTRAINT "api_keys_hash_ck" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$' and "api_keys"."prefix" ~ '^[0-9a-f]{8}$'),
	CONSTRAINT "api_keys_grants_ck" CHECK (jsonb_typeof("api_keys"."grants") = 'object'),
	CONSTRAINT "api_keys_expiry_ck" CHECK ("api_keys"."expires_at" <= "api_keys"."created_at" + interval '366 days')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reauth_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_creator_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");