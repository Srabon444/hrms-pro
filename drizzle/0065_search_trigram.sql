CREATE INDEX "employee_documents_search_idx" ON "employee_documents" USING gin ("tenant_id",("title"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "employees_search_idx" ON "employees" USING gin ("tenant_id",("full_name"::text) gin_trgm_ops,("code"::text) gin_trgm_ops,("work_email"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "expense_claims_search_idx" ON "expense_claims" USING gin ("tenant_id",("title"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "candidates_search_idx" ON "candidates" USING gin ("tenant_id",("full_name"::text) gin_trgm_ops,("email"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "assets_search_idx" ON "assets" USING gin ("tenant_id",("tag"::text) gin_trgm_ops,("name"::text) gin_trgm_ops,("serial"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tickets_search_idx" ON "tickets" USING gin ("tenant_id",("subject"::text) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "letters_search_idx" ON "letters" USING gin ("tenant_id",("subject"::text) gin_trgm_ops);