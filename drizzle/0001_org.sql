CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	CONSTRAINT "branches_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "branches_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "branches_name_ck" CHECK (length(trim("branches"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	CONSTRAINT "departments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "departments_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "departments_not_own_parent_ck" CHECK ("departments"."parent_id" is distinct from "departments"."id"),
	CONSTRAINT "departments_name_ck" CHECK (length(trim("departments"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "designations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "designations_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "designations_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "designations_name_ck" CHECK (length(trim("designations"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"rank" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "grades_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "grades_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "grades_name_ck" CHECK (length(trim("grades"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "holidays_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "holidays_date_uq" UNIQUE("tenant_id","date"),
	CONSTRAINT "holidays_name_ck" CHECK (length(trim("holidays"."name")) between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."departments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "departments_parent_idx" ON "departments" USING btree ("tenant_id","parent_id");