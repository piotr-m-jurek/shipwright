/**
 * effect-mq's Postgres JobStore + Worker layers (SHIP-109) — replaces
 * MessageQueue.ts's hand-rolled Postgres+in-memory-Queue implementation.
 *
 * JobStoreLayer only needs PgClient in context, which this app's existing
 * AppDBLiveLayer/PgClientLive (packages/db/src/index.ts) already provides —
 * reusing that single connection pool by not re-providing PgClient here,
 * same "one DB pool via reference-identity reuse" pattern server.ts
 * documents for everything else.
 */
import { Worker } from "effect-mq";
import { DrizzleJobStore } from "effect-mq/drizzle-postgres";
import {
  jobAttempts,
  jobDedupe,
  jobFlowChildren,
  jobFlowOutbox,
  jobQueues,
  jobs,
  jobSchedules,
} from "./schema";

export const JobStoreLayer = DrizzleJobStore.layer({
  jobs,
  attempts: jobAttempts,
  schedules: jobSchedules,
  queues: jobQueues,
  dedupe: jobDedupe,
  flowChildren: jobFlowChildren,
  flowOutbox: jobFlowOutbox,
});

export const WorkerLayer = Worker.layer();
