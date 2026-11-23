CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_on" date,
	"uploaded_by_user_id" uuid,
	CONSTRAINT "employee_documents_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "employee_documents_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "employee_documents_category_ck" CHECK ("employee_documents"."category" in ('identity','contract','certificate','letter','other')),
	CONSTRAINT "employee_documents_title_ck" CHECK (length(trim("employee_documents"."title")) between 1 and 160),
	CONSTRAINT "employee_documents_size_ck" CHECK ("employee_documents"."size_bytes" between 1 and 10485760)
);
--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_documents_employee_idx" ON "employee_documents" USING btree ("tenant_id","employee_id");