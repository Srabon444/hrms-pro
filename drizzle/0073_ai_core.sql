CREATE TABLE "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'gemini' NOT NULL,
	"model" text,
	"key_enc" text,
	"key_hint" text,
	"key_set_at" timestamp with time zone,
	"monthly_token_budget" integer DEFAULT 2000000 NOT NULL,
	"features" jsonb DEFAULT '{"ask":true,"ocr":true,"write":true}'::jsonb NOT NULL,
	"send_payroll" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ai_settings_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_settings_provider_ck" CHECK ("ai_settings"."provider" in ('gemini','openai','anthropic')),
	CONSTRAINT "ai_settings_model_ck" CHECK ("ai_settings"."model" is null or "ai_settings"."model" ~ '^[A-Za-z0-9._-]{1,80}$'),
	CONSTRAINT "ai_settings_budget_ck" CHECK ("ai_settings"."monthly_token_budget" between 0 and 1000000000),
	CONSTRAINT "ai_settings_key_ck" CHECK (("ai_settings"."key_enc" is null) = ("ai_settings"."key_hint" is null))
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	CONSTRAINT "ai_usage_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_usage_feature_ck" CHECK ("ai_usage"."feature" in ('ask','ocr','write','test','index')),
	CONSTRAINT "ai_usage_tokens_ck" CHECK ("ai_usage"."input_tokens" >= 0 and "ai_usage"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ai_platform" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_settings_tenant_uq" ON "ai_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("tenant_id","created_at");