/**
 * RabbitMQ-style durable message queue built on Effect + Postgres.
 *
 * Architecture
 * ────────────
 * Postgres is the source of truth. Every message is a row in `queue_messages`.
 * An in-memory Effect Queue acts as a fast-path cache of pending work so
 * workers do not need to poll the database.
 *
 * On startup the service recovers all `pending` messages from Postgres and
 * re-hydrates the in-memory queues, so no work is lost across restarts.
 *
 * RabbitMQ semantics
 * ──────────────────
 * - publish(queue, payload, opts?)    → insert row + offer to in-memory queue
 * - consume(queue, handler)           → fork a detached fiber that loops on
 *                                       Queue.take and calls handler per delivery
 * - ack(deliveryTag)                  → mark message done in Postgres
 * - nack(deliveryTag, opts?)          → increment attempts; requeue with optional
 *                                       delay if below maxAttempts, else dead-letter
 *
 * The handler receives a `Delivery<A>` with ack/nack helpers already bound to
 * the delivery tag — callers never manage raw tags.
 *
 * Error handling
 * ──────────────
 * Postgres errors are unexpected infrastructure failures and are treated as
 * defects (Effect.orDie). Only `DeliveryTagNotFoundError` is a typed error.
 */
import { Context, Effect, Fiber, FiberSet, Layer, Queue, Schema, pipe } from "effect";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { DB } from "../db/index.js";
import { queueMessages } from "./schema.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DeliveryTagNotFoundError extends Schema.TaggedErrorClass<DeliveryTagNotFoundError>()(
  "DeliveryTagNotFoundError",
  { deliveryTag: Schema.String },
) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublishOptions {
  /** Routing key — passed through for consumer filtering */
  readonly routingKey?: string;
  /** Max delivery attempts before dead-lettering. Default: 3 */
  readonly maxAttempts?: number;
  /** Delay first delivery until this date */
  readonly visibleAfter?: Date;
}

/** A message delivered to a consumer handler. */
export interface Delivery<A> {
  readonly deliveryTag: string;
  readonly payload: A;
  readonly attempts: number;
  readonly routingKey: string | undefined;
  /** Acknowledge: mark the message done in Postgres. */
  readonly ack: Effect.Effect<void>;
  /**
   * Negative-acknowledge.
   * @param opts.requeue - re-enqueue for retry (default true).
   *   Pass false to dead-letter immediately.
   * @param opts.delayMs - optional visibility delay in ms before re-delivery.
   */
  readonly nack: (opts?: { requeue?: boolean; delayMs?: number }) => Effect.Effect<void>;
}

/** Handle returned by `consume`. Call `interrupt` to stop the worker fiber. */
export interface ConsumerHandle {
  readonly interrupt: Effect.Effect<void>;
}

// ─── Internal envelope flowing through the in-memory queue ───────────────────

interface Envelope {
  readonly messageId: string;
  readonly deliveryTag: string;
  readonly queue: string;
  readonly routingKey: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly payload: any;
  readonly attempts: number;
}

// ─── Service interface ────────────────────────────────────────────────────────

interface MessageQueueInterface {
  /**
   * Publish a message to a named queue.
   * Inserts a durable row in Postgres then offers to the in-memory queue.
   * Returns the Postgres row id.
   */
  publish<A>(queue: string, payload: A, opts?: PublishOptions): Effect.Effect<string>;

  /**
   * Start consuming from a queue.
   * Forks a detached fiber that loops on Queue.take and calls `handler` for
   * each delivery. The handler must call `delivery.ack()` or `delivery.nack()`.
   * Returns a handle whose `interrupt` effect stops the consumer fiber.
   */
  consume<P, A, E, R>(
    queue: string,
    handler: (delivery: Delivery<P>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<ConsumerHandle, never, R>;

  /**
   * Acknowledge a delivery — marks the message done in Postgres.
   */
  ack(deliveryTag: string): Effect.Effect<void, DeliveryTagNotFoundError>;

  /**
   * Negative-acknowledge a delivery.
   * Requeues with optional delay if attempts < maxAttempts, otherwise
   * dead-letters.
   */
  nack(
    deliveryTag: string,
    opts?: { requeue?: boolean; delayMs?: number },
  ): Effect.Effect<void, DeliveryTagNotFoundError>;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class MessageQueue extends Context.Service<MessageQueue, MessageQueueInterface>()(
  "shipwright/queue/MessageQueue",
) {
  static readonly layer: Layer.Layer<MessageQueue, never, DB> = Layer.effect(
    MessageQueue,
    Effect.gen(function* () {
      const db = yield* DB;

      // In-memory queues: queueName → Effect Queue<Envelope>
      const memQueues = new Map<string, Queue.Queue<Envelope>>();

      // In-flight index: deliveryTag → messageId
      const inFlight = new Map<string, string>();

      // FiberSet to track consumer fibers. Layer.effect provides a Scope to
      // the generator, so FiberSet.make's Scope requirement is satisfied here.
      // The FiberSet (and all its fibers) are interrupted when the layer tears down.
      const fiberSet = yield* FiberSet.make<void, never>();

      // ── helpers ──────────────────────────────────────────────────────────

      const getOrCreateMemQueue = Effect.fn("getOrCreateMemQueue")(function* (queueName: string) {
        const existing = memQueues.get(queueName);
        if (existing !== undefined) return existing;
        const q = yield* Queue.unbounded<Envelope>();
        memQueues.set(queueName, q);
        return q;
      });

      const offerToMem = Effect.fn("offerToMem")(function* (env: Envelope) {
        const q = yield* getOrCreateMemQueue(env.queue);
        yield* Queue.offer(q, env);
      });

      // ── startup recovery ─────────────────────────────────────────────────
      // Re-hydrate in-memory queues from Postgres pending rows so no work is
      // lost across restarts.

      const now = new Date();
      const pending = yield* db
        .select()
        .from(queueMessages)
        .where(
          and(
            eq(queueMessages.status, "pending"),
            or(isNull(queueMessages.visibleAfter), lte(queueMessages.visibleAfter, now)),
          ),
        )
        .orderBy(queueMessages.createdAt)
        .pipe(Effect.orDie);

      for (const row of pending) {
        const deliveryTag = crypto.randomUUID();
        inFlight.set(deliveryTag, row.id);

        yield* db
          .update(queueMessages)
          .set({ status: "processing", deliveryTag })
          .where(eq(queueMessages.id, row.id))
          .pipe(Effect.orDie);

        yield* offerToMem({
          messageId: row.id,
          deliveryTag,
          queue: row.queue,
          routingKey: row.routingKey ?? undefined,
          payload: row.payload,
          attempts: row.attempts,
        });
      }

      // ── publish ───────────────────────────────────────────────────────────

      const publish = Effect.fn("publish")(function* <A>(
        queueName: string,
        payload: A,
        opts: PublishOptions = {},
      ) {
        const deliveryTag = crypto.randomUUID();
        const [row] = yield* db
          .insert(queueMessages)
          .values({
            queue: queueName,
            payload: payload as object,
            routingKey: opts.routingKey,
            maxAttempts: opts.maxAttempts ?? 3,
            visibleAfter: opts.visibleAfter,
            status: "processing",
            attempts: 1,
            deliveryTag,
          })
          .returning()
          .pipe(Effect.orDie);
        inFlight.set(deliveryTag, row.id);
        yield* offerToMem({
          messageId: row.id,
          deliveryTag,
          queue: queueName,
          routingKey: opts.routingKey,
          payload,
          attempts: 1,
        });
        return row.id;
      });

      // ── ack ───────────────────────────────────────────────────────────────

      const ack = Effect.fn("ack")(function* (deliveryTag: string) {
        const messageId = inFlight.get(deliveryTag);
        if (messageId === undefined) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        inFlight.delete(deliveryTag);
        yield* db
          .update(queueMessages)
          .set({ status: "done", deliveryTag: undefined })
          .where(eq(queueMessages.id, messageId))
          .pipe(Effect.orDie);
      });

      // ── nack ──────────────────────────────────────────────────────────────

      const nack = Effect.fn("nack")(function* (
        deliveryTag: string,
        opts: {
          requeue?: boolean;
          delayMs?: number;
        } = {},
      ) {
        const messageId = inFlight.get(deliveryTag);
        if (messageId === undefined) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        inFlight.delete(deliveryTag);
        const [row] = yield* db
          .select()
          .from(queueMessages)
          .where(eq(queueMessages.id, messageId))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        const nextAttempts = row.attempts + 1;
        const shouldRequeue = (opts.requeue ?? true) && nextAttempts < row.maxAttempts;
        if (!shouldRequeue) {
          yield* db
            .update(queueMessages)
            .set({ status: "dead", attempts: nextAttempts, deliveryTag: undefined })
            .where(eq(queueMessages.id, messageId))
            .pipe(Effect.orDie);
          return;
        }
        const newDeliveryTag = crypto.randomUUID();
        const visibleAfter =
          opts.delayMs !== undefined ? new Date(Date.now() + opts.delayMs) : undefined;
        yield* db
          .update(queueMessages)
          .set({
            status: "pending",
            attempts: nextAttempts,
            deliveryTag: newDeliveryTag,
            visibleAfter: visibleAfter ?? null,
          })
          .where(eq(queueMessages.id, messageId))
          .pipe(Effect.orDie);
        if (visibleAfter === undefined) {
          inFlight.set(newDeliveryTag, messageId);
          yield* offerToMem({
            messageId,
            deliveryTag: newDeliveryTag,
            queue: row.queue,
            routingKey: row.routingKey ?? undefined,
            payload: row.payload,
            attempts: nextAttempts,
          });
        }
      });

      // ── consume ───────────────────────────────────────────────────────────

      const consume = Effect.fn("consume")(function* <P, A, E, R>(
        queueName: string,
        handler: (delivery: Delivery<P>) => Effect.Effect<A, E, R>,
      ) {
        const memQueue = yield* getOrCreateMemQueue(queueName);
        const workerLoop = Effect.gen(function* () {
          while (true) {
            const envelope = yield* Queue.take(memQueue);
            const delivery: Delivery<P> = {
              deliveryTag: envelope.deliveryTag,
              payload: envelope.payload as P,
              attempts: envelope.attempts,
              routingKey: envelope.routingKey,
              ack: ack(envelope.deliveryTag).pipe(
                Effect.catchTag("DeliveryTagNotFoundError", () => Effect.void),
              ),
              nack: (nackOpts) =>
                nack(envelope.deliveryTag, nackOpts).pipe(
                  Effect.catchTag("DeliveryTagNotFoundError", () => Effect.void),
                ),
            };
            yield* handler(delivery).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("MessageQueue: handler failed, nacking").pipe(
                  Effect.andThen(Effect.logError(cause)),
                  Effect.andThen(delivery.nack({ requeue: true })),
                ),
              ),
            );
          }
        });
        const fiber: Fiber.Fiber<never, never> = yield* pipe(workerLoop, Effect.forkDetach);
        FiberSet.addUnsafe(fiberSet, fiber);
        return {
          interrupt: Effect.asVoid(Fiber.interrupt(fiber)),
        };
      });

      // ── cleanup ───────────────────────────────────────────────────────────

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const q of memQueues.values()) {
            yield* Queue.shutdown(q);
          }
        }),
      );

      return MessageQueue.of({ publish, consume, ack, nack });
    }),
  );
}
