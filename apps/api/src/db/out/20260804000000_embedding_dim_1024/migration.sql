-- Change embedding column from vector(1536) to vector(1024)
-- Required by switch from OpenAI text-embedding-3-small (1536-dim)
-- to mixedbread-ai/mxbai-embed-large-v1 (1024-dim) via HF TEI.
-- Existing chunks are dropped first since vectors from different
-- models are semantically incompatible and no prod data exists yet.

DELETE FROM chunks;

ALTER TABLE chunks
  ALTER COLUMN embedding TYPE vector(1024)
  USING embedding::text::vector(1024);
