CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"assigned_on" date NOT NULL,
	"condition_out" text NOT NULL,
	"assigned_by_user_id" uuid,
	"returned_on" date,
	"condition_in" text,
	"outcome" text,
	"charge" integer DEFAULT 0 NOT NULL,
	"return_note" text DEFAULT '' NOT NULL,
	"closed_by_user_id" uuid,
	CONSTRAINT "asset_assignments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_assignments_condition_out_ck" CHECK ("asset_assignments"."condition_out" in ('new','good','fair','poor','damaged')),
	CONSTRAINT "asset_assignments_closed_ck" CHECK (("asset_assignments"."returned_on" is null) = ("asset_assignments"."outcome" is null) and ("asset_assignments"."outcome" = 'returned') = ("asset_assignments"."condition_in" is not null)),
	CONSTRAINT "asset_assignments_condition_in_ck" CHECK ("asset_assignments"."condition_in" in ('new','good','fair','poor','damaged')),
	CONSTRAINT "asset_assignments_outcome_ck" CHECK ("asset_assignments"."outcome" in ('returned','written_off')),
	CONSTRAINT "asset_assignments_dates_ck" CHECK ("asset_assignments"."returned_on" >= "asset_assignments"."assigned_on"),
	CONSTRAINT "asset_assignments_charge_ck" CHECK ("asset_assignments"."charge" >= 0 and ("asset_assignments"."outcome" is not null or "asset_assignments"."charge" = 0)),
	CONSTRAINT "asset_assignments_note_ck" CHECK (length("asset_assignments"."return_note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"serial" text DEFAULT '' NOT NULL,
	"purchase_date" date,
	"purchase_cost" integer,
	"status" text DEFAULT 'available' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "assets_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "assets_tag_uq" UNIQUE("tenant_id","tag"),
	CONSTRAINT "assets_tag_ck" CHECK ("assets"."tag" ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
	CONSTRAINT "assets_name_ck" CHECK (length(trim("assets"."name")) between 1 and 120),
	CONSTRAINT "assets_category_ck" CHECK (length(trim("assets"."category")) between 1 and 60),
	CONSTRAINT "assets_serial_ck" CHECK (length("assets"."serial") <= 120),
	CONSTRAINT "assets_cost_ck" CHECK ("assets"."purchase_cost" is null or "assets"."purchase_cost" >= 0),
	CONSTRAINT "assets_status_ck" CHECK ("assets"."status" in ('available','assigned','repair','retired','lost')),
	CONSTRAINT "assets_notes_ck" CHECK (length("assets"."notes") <= 500)
);
--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_assignments_open_uq" ON "asset_assignments" USING btree ("tenant_id","asset_id") WHERE "asset_assignments"."returned_on" is null;--> statement-breakpoint
CREATE INDEX "asset_assignments_employee_idx" ON "asset_assignments" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "assets_status_idx" ON "assets" USING btree ("tenant_id","status");