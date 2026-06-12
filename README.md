@ai-sdk/openai      — OpenAI provider for embeddings
@ai-sdk/anthropic   — Anthropic provider (needed later, wire now)
@hono/zod-validator — request validation
zod                 — schemas
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
pnpm drizzle-kit push
pnpm dev
```

## Requirements

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> uploading: FILES_SELECTED_BY_USER
    idle --> analyzing: USER_CONFIRM
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
    complete --> [*]

    state Error {
        uploading_error
        analyzing_error
        processing_error
        re_evaluating_error
        generating_error
    }

    note right of analyzing 
        Suspend point - waits for external
        USER_CONFIRM event. 
        Does not proceed autonomously.
    end note

    note right of awaiting_answers
        Suspend point — waits for external
        USER_ANSWERED event. Does not
        proceed autonomously.
    end note
```


## TODO:
- rustfs requires more configuration in docker compose
  - https://docs.rustfs.com/installation/docker/#docker-compose-installation

---

11.06.2026

- [ ] refine prompts using rules from anthropic course
- [ ] refine testing corpus using rules from anthropic course - prompt evals
- [ ] concurrency works for now, but later on, we might need a real queue - 
- [ ] find out if RAG was not ommited in the plan - where do we retrieve chunks? where llm is answering our questions based on the acquired knowledge

  - extractor
    - extractor is wrong - it should use DB with RAG capabilities to read and answer files.
  - ask questions to the rag
  - working memory - go through all the documents in the system and summarize the main topic or problem that we are trying to solve
  - based on the summary formulate questions (to user) that have to be asked wherever there are discrepancies inside summarized knowledge
  - save user answers (with corresponding question, preferably with corresponding related documents)


  - retrieval is programmatic
  - but could be an agent that does this agentically with Tools (query database, summarizing similar chunks)
    - this is how you read
    - this is how you write
    - analyze the documents and make sense of it all

- how do we do the loop of summarizing and finding discrepancies?
  - how to build working memory
    - graphRAG
- **optional** graph RAG
  - complicated
  - 
---

03.07.2026

- [ ] consider data transfer object for db instead of raw dogging db queries in /db/queries.ts
- [ ] `agent/parsers.ts` - use `extname` from node to double check file extension (a .txt file can actually be a binary that's gonna run unexpectedly somewhere in the process)
- [ ] chunker.ts - make sure we don't split into too small chunks. what if we have very short paragraphs?
- [ ] chunker.ts - return not just list of chunks, but also metadata about those chunks, for pdf -> page number, maybe for markdown -> paragraph list, for all 
  - imagine the situation that something is on one page in a very long chapter of very long paragraph, metadata needed
- [ ] content and embedding are technically the same thing
- [ ] try typing jsons in drizzle schema with $type() method on builder
- [ ] file-type -> fileTypeFromStream - connect that with downloadPartialObject
- [ ] parsing and chunking should be on a stream not on a buffer. because we might kill the server when parsing a big file, or we parse files from multiple users. we don't have the capacity. unless you have queues and you can process only 1-3 files at a time...
  - can chunking go on streams? unpdf?
  - embedChunks has to be queued or handles queueing itself?
- [ ] deleting all the documents from everything
  - background job/schedule to remove documents that are not connected to any existing session (and remove docs chunks and from bucket)
  - consider that for one of the last phases of the project - fine tuning

---

- step 1 - parsing/indexing/chunkgin
  - consider **pictures** or **text about pictures**
    - [text] either AI is guessing what's on the pictures and the content lands in the RAG
      - [description] of what's on the picture
    - [picture] or we just put picture to the RAG
      - you can semantically compare to other pictures
      - if we have to compare pictures, then it makes sense, for knowledge retrieval - doesn't make much sense

  - authentication
    - SSO with github

    - Backend sessions
      - check out frameworks
    - session cookies instead of JWT
      - opening session
      - revoking session

  - authorization
    - roles: member, admin, superadmin,
    - RBAC? ABAC etc. (read about it)
    - [policy system in effect](https://lucas-barake.github.io/building-a-composable-policy-system/)

  - upload size
    - 100MB what if multiple users do it? 
      - ALBO stream FE -> BE -> S3 - jazda bez trzymanki i można zepsuć
      - ALBO presigned URLs - client -> Bucket
        - public, or session guarded

        - **background jobs** for listening for upload (we want to start processing uploaded file)
          - queues
          - pubsub
          - event bus in the simplest form


  - verify uploading files
    - [`file-type`](https://github.com/sindresorhus/file-type) is one of the libraries
    - if the mime type and the content actually match

  - chunking strategies
    - pdf
    - docx
---

- [ ] better error handling in `storage/index.ts`
- [ ] embedMany in `src/agent/embedder.ts` has a default batch limit, after which it throws, 
remember for later
- [ ] `src/shared/schemas/api.ts` has some wild types. figure out the way and nomenclature of typing endpoints
  - {Resource}{Action}{Role} 
  - Resource - what the endpoint operates on
  - Action - the operation (Create, Confirm, Upload)
  - Role - Request for input, Response for output

- [ ] Consider Effect-ts
  - error handling
  - type safe routes
  - mixing types between backend and frontend
  - use effect-atom on the frontend for fun

