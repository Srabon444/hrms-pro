CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" "citext" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"requires_ack" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"published_on" date NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "policies_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "policies_title_uq" UNIQUE("tenant_id","title"),
	CONSTRAINT "policies_title_ck" CHECK (length(trim("policies"."title")) between 1 and 160),
	CONSTRAINT "policies_description_ck" CHECK (length("policies"."description") <= 2000),
	CONSTRAINT "policies_version_ck" CHECK ("policies"."version" >= 1),
	CONSTRAINT "policies_size_ck" CHECK ("policies"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "policy_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_acknowledgements_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "policy_acknowledgements_uq" UNIQUE("tenant_id","policy_id","employee_id","version")
);
--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."policies"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgements" ADD CONSTRAINT "policy_acknowledgements_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_acknowledgements_employee_idx" ON "policy_acknowledgements" USING btree ("tenant_id","employee_id");