CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"entra_tenant_id" text,
	"verify_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"enforce" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sso_connections_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_connections_provider_ck" CHECK ("sso_connections"."provider" in ('google','entra')),
	CONSTRAINT "sso_connections_client_ck" CHECK (length("sso_connections"."client_id") between 1 and 200),
	CONSTRAINT "sso_connections_entra_ck" CHECK (("sso_connections"."provider" = 'entra') = ("sso_connections"."entra_tenant_id" is not null) and ("sso_connections"."entra_tenant_id" is null or "sso_connections"."entra_tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_id" uuid NOT NULL,
	"domain" "citext" NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "sso_domains_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_domains_domain_ck" CHECK ("sso_domains"."domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" "citext" NOT NULL,
	CONSTRAINT "user_identities_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sso_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."sso_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_tenant_uq" ON "sso_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_tenant_domain_uq" ON "sso_domains" USING btree ("tenant_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_verified_uq" ON "sso_domains" USING btree ("domain") WHERE "sso_domains"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_subject_uq" ON "user_identities" USING btree ("connection_id","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_user_uq" ON "user_identities" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sso_tenant_id_tenants_id_fk" FOREIGN KEY ("sso_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;