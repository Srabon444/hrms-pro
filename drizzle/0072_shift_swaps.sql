CREATE TABLE "open_shift_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"roster_entry_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "open_shift_claims_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "open_shift_claims_uq" UNIQUE("tenant_id","roster_entry_id","employee_id"),
	CONSTRAINT "open_shift_claims_status_ck" CHECK ("open_shift_claims"."status" in ('pending','approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "shift_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requester_id" uuid NOT NULL,
	"requester_entry_id" uuid NOT NULL,
	"counterpart_id" uuid NOT NULL,
	"counterpart_entry_id" uuid,
	"status" text DEFAULT 'asked' NOT NULL,
	"note" text,
	"requester_approved_by_user_id" uuid,
	"counterpart_approved_by_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "shift_swaps_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "shift_swaps_status_ck" CHECK ("shift_swaps"."status" in ('asked','accepted','approved','declined','rejected','cancelled','expired')),
	CONSTRAINT "shift_swaps_people_ck" CHECK ("shift_swaps"."requester_id" <> "shift_swaps"."counterpart_id"),
	CONSTRAINT "shift_swaps_note_ck" CHECK ("shift_swaps"."note" is null or length("shift_swaps"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "open_shift_claims" ADD CONSTRAINT "open_shift_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_shift_claims" ADD CONSTRAINT "open_shift_claims_entry_fk" FOREIGN KEY ("tenant_id","roster_entry_id") REFERENCES "public"."roster_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_shift_claims" ADD CONSTRAINT "open_shift_claims_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_requester_fk" FOREIGN KEY ("tenant_id","requester_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_counterpart_fk" FOREIGN KEY ("tenant_id","counterpart_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_requester_entry_fk" FOREIGN KEY ("tenant_id","requester_entry_id") REFERENCES "public"."roster_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swaps" ADD CONSTRAINT "shift_swaps_counterpart_entry_fk" FOREIGN KEY ("tenant_id","counterpart_entry_id") REFERENCES "public"."roster_entries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "open_shift_claims_status_ix" ON "open_shift_claims" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "shift_swaps_status_ix" ON "shift_swaps" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_swaps_requester_open_uq" ON "shift_swaps" USING btree ("tenant_id","requester_entry_id") WHERE "shift_swaps"."status" in ('asked','accepted');