/**
 * Drizzle schema for the durable message queue.
 *
 * Each row is one message. Status lifecycle:
 *   pending → processing → done
 *                       ↘ pending (nack, below max attempts)
 *                       ↘ dead (nack, max attempts reached)
 */
import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import type { ConfirmUploadRequest } from "@shipwright/shared/schemas";

/**
 * Union of all possible queue job payloads.
 * One member per queue name in job-handlers.ts.
 * Note: the discriminant is the top-level `queue` column, not a field here.
 */
export type QueueMessagePayload =
  | { readonly sessionId: AgentSessionId; readonly uploads: ConfirmUploadRequest["uploads"] }  // documents.process
  | { readonly sessionId: AgentSessionId };  // session.workflow | session.generate | session.revise

export const queueMessageStatusEnum = pgEnum("queue_message_status", [
  "pending",
  "processing",
  "done",
  "dead",
]);

export const queueMessages = pgTable("queue_messages", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),

  // The logical queue name (e.g. "documents.process")
  queue: text("queue").notNull(),

  // Optional routing key — used to filter messages within a queue (RabbitMQ-style)
  routingKey: text("routing_key"),

  // Arbitrary JSON payload
  payload: jsonb("payload").notNull().$type<QueueMessagePayload>(),

  status: queueMessageStatusEnum("status").notNull().default("pending"),

  // How many delivery attempts have been made
  attempts: integer("attempts").notNull().default(0),

  // Maximum attempts before the message is dead-lettered
  maxAttempts: integer("max_attempts").notNull().default(3),

  // Epoch ms after which the message becomes visible again after a nack.
  // null = immediately visible.
  visibleAfter: timestamp("visible_after"),

  // The delivery tag used by the consumer to ack/nack this specific delivery.
  // Reset on each re-delivery. Mirrors AMQP delivery-tag semantics.
  deliveryTag: uuid("delivery_tag"),
});

export type QueueMessageInsert = typeof queueMessages.$inferInsert;
export type QueueMessageSelect = typeof queueMessages.$inferSelect;
