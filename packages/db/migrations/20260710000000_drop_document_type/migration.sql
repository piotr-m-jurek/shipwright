ALTER TABLE "documents" DROP COLUMN "document_type";--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "document_type";--> statement-breakpoint
DROP TYPE "document_type";
