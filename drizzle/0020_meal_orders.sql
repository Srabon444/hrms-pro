CREATE TABLE "meal_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by_user_id" uuid,
	CONSTRAINT "meal_days_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_days_date_uq" UNIQUE("tenant_id","date")
);
--> statement-breakpoint
CREATE TABLE "meal_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"meal_type_id" uuid NOT NULL,
	"status" text NOT NULL,
	"guest_qty" smallint DEFAULT 0 NOT NULL,
	"unit_cost" integer,
	"subsidy_pct" smallint,
	"updated_by_user_id" uuid,
	CONSTRAINT "meal_orders_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "meal_orders_day_uq" UNIQUE("tenant_id","employee_id","date","meal_type_id"),
	CONSTRAINT "meal_orders_status_ck" CHECK ("meal_orders"."status" in ('ordered','opted_out','auto_off')),
	CONSTRAINT "meal_orders_guests_ck" CHECK ("meal_orders"."guest_qty" between 0 and 10),
	CONSTRAINT "meal_orders_price_ck" CHECK (("meal_orders"."unit_cost" is null) = ("meal_orders"."subsidy_pct" is null))
);
--> statement-breakpoint
ALTER TABLE "meal_days" ADD CONSTRAINT "meal_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_orders" ADD CONSTRAINT "meal_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_orders" ADD CONSTRAINT "meal_orders_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_orders" ADD CONSTRAINT "meal_orders_type_fk" FOREIGN KEY ("tenant_id","meal_type_id") REFERENCES "public"."meal_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;