/**
 * Drizzle schema for effect-mq's Postgres-backed job store (SHIP-109).
 *
 * Re-exports effect-mq's table factories so drizzle-kit owns the migrations
 * for these tables the same way it does for every other table in this repo —
 * see drizzle.config.ts's `schema` array, which already lists this file
 * alongside packages/db/src/schema.ts. These tables have zero .references()
 * into the app's relational graph (job payloads carry sessionId as opaque
 * JSON, not a SQL FK), so — like the old queue_messages table before it —
 * they stay independently owned here rather than in packages/db.
 *
 * QueueJobName mirrors the `_tag` of every Job.make(...) definition in
 * jobs.ts — kept as a hand-typed union (not derived via `typeof X._tag`)
 * because packages/queue's schema.ts must not import from jobs.ts: jobs.ts
 * needs these tables' types to build the JobStore layer, and a schema.ts ->
 * jobs.ts import would invert that dependency into a cycle. Keep this union
 * in sync with jobs.ts's four Job.make tags by hand.
 */
import {
  mqDedupe,
  mqFlowChildren,
  mqFlowOutbox,
  mqJobAttempts,
  mqJobs,
  mqQueueControl,
  mqSchedules,
} from "effect-mq/drizzle-postgres";

export type QueueJobName =
  | "documents.process"
  | "session.workflow"
  | "session.generate"
  | "session.revise";

export const jobs = mqJobs<QueueJobName>();
export const jobAttempts = mqJobAttempts(jobs);
export const jobSchedules = mqSchedules<QueueJobName>();
export const jobQueues = mqQueueControl();
export const jobDedupe = mqDedupe<QueueJobName>();
export const jobFlowChildren = mqFlowChildren();
export const jobFlowOutbox = mqFlowOutbox();
