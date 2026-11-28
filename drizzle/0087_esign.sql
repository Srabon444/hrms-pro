CREATE TABLE "signature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"offer_id" uuid,
	"created_by_user_id" uuid,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"certificate_key" text,
	"certificate_sha256" text,
	"decline_reason" text,
	CONSTRAINT "signature_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "signature_requests_title_ck" CHECK (length(trim("signature_requests"."title")) between 1 and 200),
	CONSTRAINT "signature_requests_file_name_ck" CHECK (length("signature_requests"."file_name") between 1 and 200),
	CONSTRAINT "signature_requests_size_ck" CHECK ("signature_requests"."file_size" > 0),
	CONSTRAINT "signature_requests_sha_ck" CHECK ("signature_requests"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signature_requests_status_ck" CHECK ("signature_requests"."status" in ('draft','pending','completed','declined','cancelled')),
	CONSTRAINT "signature_requests_sent_ck" CHECK (("signature_requests"."status" = 'draft') = ("signature_requests"."sent_at" is null)),
	CONSTRAINT "signature_requests_completed_ck" CHECK (("signature_requests"."status" = 'completed') = ("signature_requests"."completed_at" is not null and "signature_requests"."certificate_key" is not null and "signature_requests"."certificate_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "signature_requests_decline_ck" CHECK ("signature_requests"."decline_reason" is null or ("signature_requests"."status" = 'declined' and length("signature_requests"."decline_reason") <= 500))
);
--> statement-breakpoint
CREATE TABLE "signature_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"sort_order" smallint NOT NULL,
	"employee_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"token_hash" text,
	"invited_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"method" text,
	"ip" text,
	"user_agent" text,
	"typed_name" text,
	"otp_hash" text,
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" smallint DEFAULT 0 NOT NULL,
	"otp_sends" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "signature_signers_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "signature_signers_order_uq" UNIQUE("tenant_id","request_id","sort_order"),
	CONSTRAINT "signature_signers_name_ck" CHECK (length(trim("signature_signers"."name")) between 1 and 200),
	CONSTRAINT "signature_signers_email_ck" CHECK (length("signature_signers"."email") between 3 and 254),
	CONSTRAINT "signature_signers_status_ck" CHECK ("signature_signers"."status" in ('waiting','signed','declined')),
	CONSTRAINT "signature_signers_method_ck" CHECK ("signature_signers"."method" is null or "signature_signers"."method" in ('session','email_otp')),
	CONSTRAINT "signature_signers_signed_ck" CHECK (("signature_signers"."status" = 'signed') = ("signature_signers"."signed_at" is not null and "signature_signers"."method" is not null and length(trim(coalesce("signature_signers"."typed_name", ''))) between 1 and 200)),
	CONSTRAINT "signature_signers_declined_ck" CHECK (("signature_signers"."status" = 'declined') = ("signature_signers"."declined_at" is not null)),
	CONSTRAINT "signature_signers_method_kind_ck" CHECK ("signature_signers"."method" is null or ("signature_signers"."method" = 'session') = ("signature_signers"."employee_id" is not null)),
	CONSTRAINT "signature_signers_otp_attempts_ck" CHECK ("signature_signers"."otp_attempts" between 0 and 5),
	CONSTRAINT "signature_signers_otp_sends_ck" CHECK ("signature_signers"."otp_sends" between 0 and 3),
	CONSTRAINT "signature_signers_ua_ck" CHECK ("signature_signers"."user_agent" is null or length("signature_signers"."user_agent") <= 500),
	CONSTRAINT "signature_signers_ip_ck" CHECK ("signature_signers"."ip" is null or length("signature_signers"."ip") <= 64)
);
--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."signature_requests"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signature_requests_status_idx" ON "signature_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_requests_offer_live_uq" ON "signature_requests" USING btree ("tenant_id","offer_id") WHERE "signature_requests"."offer_id" is not null and "signature_requests"."status" in ('draft','pending','completed');--> statement-breakpoint
CREATE UNIQUE INDEX "signature_signers_email_uq" ON "signature_signers" USING btree ("tenant_id","request_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "signature_signers_token_uq" ON "signature_signers" USING btree ("token_hash");