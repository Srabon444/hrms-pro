CREATE TABLE "file_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy_id" uuid,
	"candidate_id" uuid,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"model" text,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "file_texts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "file_texts_source_ck" CHECK (num_nonnulls("file_texts"."policy_id", "file_texts"."candidate_id") = 1),
	CONSTRAINT "file_texts_status_ck" CHECK ("file_texts"."status" in ('ok','failed')),
	CONSTRAINT "file_texts_text_ck" CHECK (length("file_texts"."text") <= 200000),
	CONSTRAINT "file_texts_attempts_ck" CHECK ("file_texts"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "file_texts" ADD CONSTRAINT "file_texts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_texts" ADD CONSTRAINT "file_texts_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."policies"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_texts" ADD CONSTRAINT "file_texts_candidate_fk" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_texts_policy_uq" ON "file_texts" USING btree ("tenant_id","policy_id") WHERE "file_texts"."policy_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "file_texts_candidate_uq" ON "file_texts" USING btree ("tenant_id","candidate_id") WHERE "file_texts"."candidate_id" is not null;--> statement-breakpoint
CREATE INDEX "file_texts_tsv_idx" ON "file_texts" USING gin ("tsv");