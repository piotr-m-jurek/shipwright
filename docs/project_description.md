# Project Idea: Project Description Agent

**One-liner:** An agent that ingests a messy bundle of project inputs — short brief, supporting documents, meeting transcripts — and produces both a human-readable project brief and a coding-agent-ready implementation PRD.

---

## What you're building

A tool a project lead can drop a folder of project inputs into — a short description, supporting documents (PRD draft, RFP, design notes), and meeting transcripts — and get back two artifacts. The first is a clean **Project Brief** a stakeholder can read in five minutes to understand what the project is and what needs to be built. The second is an **Implementation PRD** structured as a prompt for a coding agent (Claude Code, Cursor, Codex), detailed enough that the agent can start work without further clarification.

Both outputs are downloadable via presigned URL — file bytes are served directly from storage, not through the backend. After reviewing the outputs, the user can submit free-form revision feedback and trigger a re-generation pass. Each revision increments the output version and is stored alongside previous versions.

Before producing either output, the agent analyzes the inputs, identifies gaps and contradictions, and asks the user a small set of targeted clarifying questions.

---

## Why this project is interesting

This is a realistic presales problem — close to what people actually do every week — and the happy path is deceptively easy. The hard part is everything around it: long messy inputs that won't fit cleanly into context, contradictions between the transcript and the PRD draft, knowing when to stop asking clarifying questions, and — most distinctively — the fact that one of the two outputs is itself a prompt for another agent. Designing a PRD that makes a coding agent perform well is a different skill than writing one for a human. That meta-prompting layer is where this project earns its keep as an upskilling exercise.

---

## Key design decisions you'll need to make

**Document ingestion strategy** — You'll get PDFs, DOCX, plain text, transcripts. Pick two or three formats and handle them well rather than trying to cover everything. Documents are always chunked and embedded at upload time — the chunks are the primary read path for every analysis pass.

**Per-document summarization via map-reduce** — The analysis pipeline never reads raw document text directly into a single LLM call. Instead it reads chunks from the DB and summarizes each document independently. For large documents (many chunks), this uses a map-reduce strategy: summarize batches of chunks into intermediate summaries, then reduce those intermediates into a final per-document summary. Each summary is stored in the DB. This keeps individual LLM calls within context limits regardless of document size, and produces a compact representation that downstream passes can reason over.

**Context vs. retrieval** — Per-document summaries are compact enough to fit in context together for most realistic bundles. For very large bundles (many documents, each with a long summary), the system falls back to retrieval over summaries. This guard lives in the XState machine and is the fallback path, not the primary one.

**Clarifying question loop** — The agent identifies gaps, ambiguities, and conflicts, then asks the user a small number of targeted questions. Three to seven, not thirty. The agent must know when to stop. This is a genuine HITL pattern, not a chatty UX choice — make it explicit.

**Conflict detection from summaries** — After per-document summaries are produced, the Challenger pass compares them. Contradictions between documents are visible at the summary level — the summaries are compact enough to reason across without retrieving raw chunks. Conflicts are surfaced to the user in the clarifying loop.

**Handling source conflicts** — The transcript says X, the PRD draft says Y. Surface the conflict to the user, ask, or auto-resolve with a noted assumption? There's no single right answer, but the system needs a deliberate one.

**Grounding and anti-hallucination** — The agent must not invent requirements that aren't in the source material. Hallucinated scope is the worst possible failure mode here, because the output looks plausible and gets pasted into a coding agent. Design the prompt and context injection so the model stays grounded, and consider explicit citations back to source documents in the Project Brief.

**The second file is a prompt** — The Implementation PRD isn't written for a human reader. It's written for a coding agent that will read it and start implementing. That changes everything about its structure: explicit acceptance criteria, file/module hints, non-goals, edge cases, recommended stack. Treat this as a prompt engineering exercise, not a writing exercise.

---

## Stretch goals

- **Multi-agent split:** One agent extracts, one challenges (looks for contradictions and gaps), one writes. Produces noticeably better outputs than a single-agent design.
- **Direct handoff to a coding agent:** Wire the Implementation PRD into a Claude Code or Cursor session and demo the full flow from messy inputs to running code.
- **Versioning:** Re-run with new docs added later and produce a diff against the previous brief — what changed, what new constraints appeared, what got dropped.
- **Multimodal intake:** Accept voice memos directly (audio → transcript → analysis).
- **Eval suite:** 10–15 cases covering faithfulness (no hallucinated requirements), completeness (nothing important dropped), and conflict handling (correct surfacing of contradictions). LLM-as-judge for the qualitative bits, deterministic checks for the structural ones.

---

## Modules this project primarily exercises

| Module | How |
|--------|-----|
| M1 | Provider SDK, structured outputs for the analysis pass, conversation history for the clarifying loop |
| M2 | Heavy. Multiple long documents in context, summarization, prompt caching across passes, explicit meta-prompting when generating the Implementation PRD |
| M3 | File-reading tools; optionally an MCP server for project metadata or to attach more docs mid-flow |
| M4 | Chunking and retrieval over the input bundle when it gets long; metadata filters by document type |
| M5 | The clarifying loop is properly agentic — model decides what to ask, when to stop, when it has enough; multi-agent split as a stretch |
| M6 | Eval suite focused on faithfulness; prompt injection from untrusted transcripts and external docs; observability with Langfuse |

---

## A note on scope

Don't build a SaaS. A CLI or thin web UI is enough. Don't build your own vector DB — use pgvector. Get one realistic project bundle working end-to-end before you broaden the supported formats or add features. The point of the project is the analysis, clarifying loop, and dual-output design — not the wrapping around it.
