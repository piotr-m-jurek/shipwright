import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { chunks, documents, agentSessions } from "../../db/schema.js";
import { z } from "zod/v4";

export const InsertDocumentSchema = createInsertSchema(documents);
export type InsertDocument = z.infer<typeof InsertDocumentSchema>;
export const SelectDocumentSchema = createSelectSchema(documents);
export type SelectDocument = z.infer<typeof SelectDocumentSchema>;

export const InsertAgentSessionSchema = createInsertSchema(agentSessions);
export type InsertAgentSession = z.infer<typeof InsertAgentSessionSchema>;
export const SelectAgentSessionSchema = createSelectSchema(agentSessions);
export type SelectAgentSession = z.infer<typeof SelectAgentSessionSchema>;

export const InsertChunkSchema = createInsertSchema(chunks);
export type InsertChunk = z.infer<typeof InsertChunkSchema>;
export const SelectChunkSchema = createSelectSchema(chunks);
export type SelectChunk = z.infer<typeof SelectChunkSchema>;

const FileMetaSchema = z.object({
  filename: z.string(),
  documentType: InsertDocumentSchema.shape.documentType,
});
export const UploadRequestSchema = z.object({ files: z.array(FileMetaSchema).min(1) });
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const ChunkMetaSchema = InsertChunkSchema.pick({
  documentType: true,
  chunkIndex: true,
  sessionId: true,
  documentId: true,
});
export type ChunkMeta = z.infer<typeof ChunkMetaSchema>;
