CREATE TYPE "document_type" AS ENUM('transcript', 'prd_draft', 'rfp', 'notes');--> statement-breakpoint
CREATE TYPE "input_mode" AS ENUM('context', 'retrieval');--> statement-breakpoint
CREATE TYPE "role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "output_type" AS ENUM('project_brief', 'implementation_prd');--> statement-breakpoint
CREATE TYPE "session_status" AS ENUM('idle', 'uploading', 'processing', 'analyzing', 'awaiting_answers', 're_evaluating', 'generating', 'complete', 'error');--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"text" text NOT NULL,
	"round" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"document_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"document_type" "document_type" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"document_type" "document_type" NOT NULL,
	"storage_path" text,
	"raw_text" text,
	"token_count" integer
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"content" text NOT NULL,
	"role" "role" NOT NULL,
	"agent_pass" text
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"type" "output_type" NOT NULL,
	"content" text,
	"version" integer
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source_documents" text[] NOT NULL,
	"rationale" text NOT NULL,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" "session_status" DEFAULT 'idle'::"session_status" NOT NULL,
	"input_mode" "input_mode" DEFAULT 'context'::"input_mode" NOT NULL,
	"xstate_snapshot" jsonb
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;