CREATE TYPE "confidence_level" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "document_status" AS ENUM('pending', 'uploaded', 'processing', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "queue_message_status" AS ENUM('pending', 'processing', 'done', 'dead');--> statement-breakpoint
CREATE TYPE "summary_item_type" AS ENUM('requirement', 'constraint', 'assumption');--> statement-breakpoint
CREATE TYPE "summary_type" AS ENUM('map_intermediate', 'final');--> statement-breakpoint
ALTER TYPE "session_status" ADD VALUE 'revising' BEFORE 'error';--> statement-breakpoint
ALTER TYPE "session_status" ADD VALUE 'partial_error';--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"status" "session_status" DEFAULT 'idle'::"session_status" NOT NULL,
	"input_mode" "input_mode" DEFAULT 'context'::"input_mode" NOT NULL,
	"xstate_snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE "document_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_document" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"summary_type" "summary_type" NOT NULL,
	"batch_index" integer,
	"content" text NOT NULL,
	"token_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"queue" text NOT NULL,
	"routing_key" text,
	"payload" jsonb NOT NULL,
	"status" "queue_message_status" DEFAULT 'pending'::"queue_message_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"visible_after" timestamp,
	"delivery_tag" uuid
);
--> statement-breakpoint
CREATE TABLE "summary_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"summary_id" uuid NOT NULL,
	"item_type" "summary_item_type" NOT NULL,
	"text" text NOT NULL,
	"source_document" text NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" DROP CONSTRAINT "answers_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "chunks" DROP CONSTRAINT "chunks_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "outputs" DROP CONSTRAINT "outputs_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_session_id_sessions_id_fkey";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "char_offset" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "heading_path" text[];--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page_number" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mime_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "size_bytes" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_status" "document_status" DEFAULT 'pending'::"document_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "s3_key" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "expires_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "document_type";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "document_type";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "input_mode";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "xstate_snapshot";--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(1024) USING "embedding"::vector(1024);--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_key" UNIQUE("token");--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" ("identifier");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "summary_items" ADD CONSTRAINT "summary_items_summary_id_document_summaries_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "document_summaries"("id") ON DELETE CASCADE;--> statement-breakpoint
DROP TYPE "document_type";