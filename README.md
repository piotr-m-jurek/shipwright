# Shipwright

An AI agent that ingests a messy bundle of project inputs — briefs, PRD drafts, RFPs, meeting transcripts — analyses them for gaps and contradictions, asks a targeted set of clarifying questions, and produces two outputs: a human-readable **Project Brief** and a coding-agent-ready **Implementation PRD**.

## Stack

| Layer | Technology |
|---|---|
| API | Hono + Hono RPC |
| Agent / Orchestration | Vercel AI SDK Core + XState |
| LLM | Claude 3.7 Sonnet (Anthropic via Vercel AI SDK) |
| Document Processing | unpdf + mammoth + Node.js fs |
| Vector DB | PostgreSQL + pgvector + Drizzle ORM |
| Embeddings | OpenAI text-embedding-3-small |
| File Storage | StorageAdapter + @aws-sdk/client-s3 + rustfs (local) |
| Observability | Langfuse |

## Build progress

Session history, completed phases, decisions, and deviations are tracked in [`docs/progress.md`](docs/progress.md). Read this first when resuming work in a new session.

## Local setup

```bash
cp .env.example .env
# fill in .env values
docker compose up -d
pnpm install
pnpm db:push
pnpm dev
```

## State machine

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> uploading: FILES_SELECTED_BY_USER
    uploading --> processing: UPLOAD_COMPLETE
    uploading --> uploading_error: ERROR
    processing --> analyzing: USER_CONFIRM [hasEnoughContext && tokensBelowThreshold]
    processing --> processing_error: ERROR
    analyzing --> awaiting_answers: ANALYSIS_DONE
    analyzing --> analyzing_error: ERROR
    awaiting_answers --> re_evaluating: USER_ANSWERED
    re_evaluating --> awaiting_answers: ANSWERS_INSUFFICIENT [round < 2]
    re_evaluating --> generating: ANSWERS_SUFFICIENT
    re_evaluating --> generating: ANSWERS_INSUFFICIENT [roundLimitReached]
    re_evaluating --> re_evaluating_error: ERROR
    generating --> complete: OUTPUT_READY
    generating --> generating_error: ERROR
    complete --> revising: REVISION_REQUESTED
    revising --> awaiting_answers: ANALYSIS_DONE [new questions surfaced]
    revising --> generating: ANALYSIS_DONE [no new questions]
    revising --> revising_error: ERROR

    state Error {
        uploading_error
        processing_error
        analyzing_error
        re_evaluating_error
        generating_error
        revising_error
    }

    note right of analyzing
        Suspend point — waits for external
        USER_CONFIRM event.
        Does not proceed autonomously.
    end note

    note right of awaiting_answers
        Suspend point — waits for external
        USER_ANSWERED event. Does not
        proceed autonomously.
    end note

    note right of revising
        Triggered by REVISION_REQUESTED
        carrying free-form feedback string.
        outputVersion increments on each
        pass through generating.
    end note
```

**Machine context shape:**
`sessionId`, `documents[]`, `documentSummaries[]`, `questions[]`, `answers[]`,
`round`, `inputMode (context | retrieval)`, `agentAnalysis`, `revisionFeedback`,
`outputVersion`, `outputs{}`

Full schema: `src/shared/schemas/machine.ts`
