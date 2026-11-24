CREATE TABLE "letter_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" "citext" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "letter_templates_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "letter_templates_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "letter_templates_kind_ck" CHECK ("letter_templates"."kind" in ('offer','appointment','confirmation','increment','experience','salary_certificate','other')),
	CONSTRAINT "letter_templates_name_ck" CHECK (length(trim("letter_templates"."name")) between 1 and 80),
	CONSTRAINT "letter_templates_subject_ck" CHECK (length(trim("letter_templates"."subject")) between 1 and 160),
	CONSTRAINT "letter_templates_body_ck" CHECK (length(trim("letter_templates"."body")) between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"issued_on" date NOT NULL,
	"issued_by_user_id" uuid,
	CONSTRAINT "letters_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "letters_number_uq" UNIQUE("tenant_id","number"),
	CONSTRAINT "letters_kind_ck" CHECK ("letters"."kind" in ('offer','appointment','confirmation','increment','experience','salary_certificate','other')),
	CONSTRAINT "letters_number_ck" CHECK ("letters"."number" > 0),
	CONSTRAINT "letters_subject_ck" CHECK (length(trim("letters"."subject")) between 1 and 160),
	CONSTRAINT "letters_body_ck" CHECK (length(trim("letters"."body")) between 1 and 20000),
	CONSTRAINT "letters_size_ck" CHECK ("letters"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "letter_templates" ADD CONSTRAINT "letter_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letters" ADD CONSTRAINT "letters_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."letter_templates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "letters_employee_idx" ON "letters" USING btree ("tenant_id","employee_id");