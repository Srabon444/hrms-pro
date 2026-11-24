ALTER TABLE "audit_sensitive" DROP CONSTRAINT "audit_sensitive_audit_fk";
--> statement-breakpoint
ALTER TABLE "audit_sensitive" ADD CONSTRAINT "audit_sensitive_audit_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;