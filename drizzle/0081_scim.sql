ALTER TABLE "memberships" ADD COLUMN "disabled_by" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "scim_prefix" text;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "scim_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_scim_uq" ON "sso_connections" USING btree ("scim_token_hash");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_disabled_by_ck" CHECK ("memberships"."disabled_by" is null or "memberships"."disabled_by" in ('hr','scim','exit'));--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_scim_ck" CHECK (("sso_connections"."scim_prefix" is null) = ("sso_connections"."scim_token_hash" is null));