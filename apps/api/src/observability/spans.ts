export const Spans = {
  session: (sessionId: string) => ({
    "langfuse.session.id": sessionId,
    "shipwright.session.id": sessionId,
  }),

  document: (opts: { filename: string; id?: string }) => ({
    "shipwright.document.filename": opts.filename,
    ...(opts.id !== undefined ? { "shipwright.document.id": opts.id } : {}),
  }),

  chunk: (index: number) => ({
    "shipwright.chunk.index": index,
  }),

  pass: (name: string) => ({
    "shipwright.pass": name,
  }),

  counts: (opts: {
    documents?: number;
    answers?: number;
    feedbackLength?: number;
    conflicts?: number;
    gaps?: number;
    ambiguities?: number;
  }) => ({
    ...(opts.documents !== undefined ? { "shipwright.document.count": opts.documents } : {}),
    ...(opts.answers !== undefined ? { "shipwright.answer.count": opts.answers } : {}),
    ...(opts.feedbackLength !== undefined
      ? { "shipwright.revision.feedback.length": opts.feedbackLength }
      : {}),
    ...(opts.conflicts !== undefined ? { "shipwright.gap.conflicts": opts.conflicts } : {}),
    ...(opts.gaps !== undefined ? { "shipwright.gap.gaps": opts.gaps } : {}),
    ...(opts.ambiguities !== undefined ? { "shipwright.gap.ambiguities": opts.ambiguities } : {}),
  }),
} as const;
