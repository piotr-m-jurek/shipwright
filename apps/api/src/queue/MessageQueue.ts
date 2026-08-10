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
import { Context, Duration, Effect, Fiber, FiberSet, Layer, Metric, Option, Queue, Schema, pipe } from "effect";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { DB } from "../db/index.js";
import { type QueueMessagePayload, queueMessages } from "./schema.js";

// ─── Backoff ─────────────────────────────────────────────────────────────────

/**
 * Exponential backoff delay for nack retries.
 *
 * attempt 1 → 0 ms  (immediate — first try, no delay)
 * attempt 2 → 5 s   (base)
 * attempt 3 → 10 s  (base × 2)
 * attempt 4 → 20 s  (base × 4)
 * …
 *
 * Uses the same formula as `Schedule.exponential(base, factor)`:
 *   delay = base × factor^(attempt - 2)
 */
const nackDelayMs = (attempt: number): number =>
  attempt <= 1
    ? 0
    : Duration.toMillis(Duration.times(Duration.seconds(5), Math.pow(2, attempt - 2)));

// ─── Metrics ─────────────────────────────────────────────────────────────────

export const deadLetteredCounter = Metric.counter("shipwright.queue.dead_lettered", {
  description: "Number of queue messages dead-lettered after exhausting retries",
});

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
  readonly routingKey: Option.Option<string>;
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
  readonly routingKey: Option.Option<string>;
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
        const existing = Option.fromUndefinedOr(memQueues.get(queueName));
        if (Option.isSome(existing)) return existing.value;
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
          routingKey: Option.fromNullOr(row.routingKey),
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
        const routingKey = Option.fromUndefinedOr(opts.routingKey);
        const [row] = yield* db
          .insert(queueMessages)
          .values({
            queue: queueName,
            payload: payload as QueueMessagePayload,
            routingKey: Option.getOrUndefined(routingKey),
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
          routingKey,
          payload,
          attempts: 1,
        });
        return row.id;
      });

      // ── ack ───────────────────────────────────────────────────────────────

      const ack = Effect.fn("ack")(function* (deliveryTag: string) {
        const messageId = Option.fromUndefinedOr(inFlight.get(deliveryTag));
        if (Option.isNone(messageId)) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        inFlight.delete(deliveryTag);
        yield* db
          .update(queueMessages)
          // deliveryTag: undefined is Drizzle's convention for "set column to NULL"
          .set({ status: "done", deliveryTag: undefined })
          .where(eq(queueMessages.id, messageId.value))
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
        const messageId = Option.fromUndefinedOr(inFlight.get(deliveryTag));
        if (Option.isNone(messageId)) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        inFlight.delete(deliveryTag);
        const [row] = yield* db
          .select()
          .from(queueMessages)
          .where(eq(queueMessages.id, messageId.value))
          .limit(1)
          .pipe(Effect.orDie);
        const rowOpt = Option.fromUndefinedOr(row);
        if (Option.isNone(rowOpt)) {
          return yield* new DeliveryTagNotFoundError({ deliveryTag });
        }
        const msg = rowOpt.value;
        const nextAttempts = msg.attempts + 1;
        const shouldRequeue = (opts.requeue ?? true) && nextAttempts < msg.maxAttempts;
        if (!shouldRequeue) {
          yield* Effect.logError("queue: message dead-lettered").pipe(
            Effect.annotateLogs({
              messageId: messageId.value,
              queue: msg.queue,
              routingKey: msg.routingKey ?? undefined,
              attempts: nextAttempts,
            }),
          );
          yield* Metric.update(deadLetteredCounter, 1);
          yield* db
            .update(queueMessages)
            // deliveryTag: undefined is Drizzle's convention for "set column to NULL"
            .set({ status: "dead", attempts: nextAttempts, deliveryTag: undefined })
            .where(eq(queueMessages.id, messageId.value))
            .pipe(Effect.orDie);
          return;
        }
        const newDeliveryTag = crypto.randomUUID();
        const visibleAfter = Option.map(
          Option.fromUndefinedOr(opts.delayMs),
          (ms) => new Date(Date.now() + ms),
        );
        yield* db
          .update(queueMessages)
          .set({
            status: "pending",
            attempts: nextAttempts,
            deliveryTag: newDeliveryTag,
            // DB boundary: nullable column, Option → null
            visibleAfter: Option.getOrNull(visibleAfter),
          })
          .where(eq(queueMessages.id, messageId.value))
          .pipe(Effect.orDie);
        if (Option.isNone(visibleAfter)) {
          inFlight.set(newDeliveryTag, messageId.value);
          yield* offerToMem({
            messageId: messageId.value,
            deliveryTag: newDeliveryTag,
            queue: msg.queue,
            routingKey: Option.fromNullOr(msg.routingKey),
            payload: msg.payload,
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
                  Effect.andThen(
                    delivery.nack({
                      requeue: true,
                      delayMs: nackDelayMs(envelope.attempts),
                    }),
                  ),
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
