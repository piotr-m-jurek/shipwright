import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import { chunks, documents, agentSessions } from "../../db/schema.js";
import z from "zod/v4";

export const InsertDocumentSchema = createInsertSchema(documents);
export const InsertChunkSchema = createInsertSchema(chunks);
export const InsertSessionSchema = createInsertSchema(agentSessions);

export const SelectDocumentSchema = createSelectSchema(documents);
export const SelectChunkSchema = createSelectSchema(chunks);
export const SelectSessionSchema = createSelectSchema(agentSessions);

export const UploadRequestSchema = InsertDocumentSchema.pick({ documentType: true });
export const ChunkMetaSchema = InsertChunkSchema.pick({
  documentType: true,
  chunkIndex: true,
  sessionId: true,
  documentId: true,
}).extend({ sourceDocument: z.string() });
