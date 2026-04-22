import crypto from 'node:crypto';
import {
  canonicalJson,
  type WebhookEnvelope,
  type WebhookEventType,
  WEBHOOK_HEADERS,
} from '@yantra/webhook-spec';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../utils/secrets.js';

// ──────────────────────────────────────────────────────────────────────────
// Outbound webhook subsystem.
//
// Flow:
//   1. Engine (or any service) calls dispatchEvent() with a domain event.
//   2. We fan out to every enabled WebhookSubscription for that operator
//      whose `eventTypes` list includes the event type (or is empty →
//      subscribed to all).
//   3. Each fan-out inserts a WebhookDelivery row in PENDING state with
//      nextAttemptAt = now. The DeliveryRunner picks them up and POSTs.
//   4. On 2xx response → SUCCEEDED. On non-2xx or network error →
//      FAILED_RETRY with exponential backoff capped at 1h; after 8 tries
//      → DEAD_LETTERED.
//
// Signing: HMAC-SHA256(subscription secret, canonical JSON of envelope).
// Header carries the version so receivers can validate across rotations.
//
// The runner is a simple poll loop — for the v1 footprint (N operators
// × few subscriptions each × modest event rate) this is sufficient.
// Switching to a pg-native LISTEN/NOTIFY is a v2 follow-up if the
// polling cost shows up in metrics.

const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;
const POLL_MS = 5_000;
const DELIVERY_TIMEOUT_MS = 8_000;

function backoffFor(attempt: number): number {
  // Exponential with cap: 30s, 60s, 2m, 4m, 8m, 16m, 32m, 1h
  const ms = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
}

export interface DispatchEventInput {
  operatorId: string;
  eventType: WebhookEventType;
  data: unknown;
  dataVersion?: number;
  eventId?: string;
  occurredAt?: Date;
}

export async function dispatchEvent(input: DispatchEventInput): Promise<void> {
  const eventId = input.eventId ?? crypto.randomUUID();
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { operatorId: input.operatorId, enabled: true },
  });
  if (subscriptions.length === 0) return;

  const interested = subscriptions.filter(
    (s) => s.eventTypes.length === 0 || s.eventTypes.includes(input.eventType),
  );
  if (interested.length === 0) return;

  const envelope: WebhookEnvelope = {
    eventId,
    eventType: input.eventType,
    occurredAt,
    operatorId: input.operatorId,
    dataVersion: input.dataVersion ?? 1,
    data: input.data,
  };
  const body = canonicalJson(envelope);

  for (const sub of interested) {
    try {
      const secret = decryptSecret(Buffer.from(sub.secretCipher));
      const signature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      await prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          operatorId: input.operatorId,
          eventId,
          eventType: input.eventType,
          payload: envelope as unknown as object,
          signature,
          state: 'PENDING',
          nextAttemptAt: new Date(),
        },
      });
    } catch (err) {
      logger.error('webhook_dispatch_queue_failed', {
        operatorId: input.operatorId,
        subscriptionId: sub.id,
        err: (err as Error).message,
      });
    }
  }
}

// ── Runner (delivery loop) ─────────────────────────────────

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('WebhookDispatcher started', { pollMs: POLL_MS });
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => logger.error('webhook_dispatcher_tick_failed', {
          err: (err as Error).message,
        }))
        .finally(() => this.schedule());
    }, POLL_MS);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const batch = await prisma.webhookDelivery.findMany({
      where: {
        state: { in: ['PENDING', 'FAILED_RETRY'] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 50,
    });
    if (batch.length === 0) return;

    await Promise.all(batch.map((d) => this.deliver(d.id)));
  }

  private async deliver(deliveryId: string): Promise<void> {
    // Claim the row by transitioning to IN_FLIGHT. If the update changes
    // 0 rows someone else got it; skip.
    const claimed = await prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, state: { in: ['PENDING', 'FAILED_RETRY'] } },
      data: { state: 'IN_FLIGHT' },
    });
    if (claimed.count === 0) return;

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { subscription: true },
    });
    if (!delivery || !delivery.subscription) return;

    const sub = delivery.subscription;
    const envelope = delivery.payload;
    const body = canonicalJson(envelope);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const started = Date.now();
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let networkError: string | null = null;
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_HEADERS.signature]: delivery.signature,
          [WEBHOOK_HEADERS.signatureAlg]: 'HMAC-SHA256',
          [WEBHOOK_HEADERS.signatureVersion]: sub.secretVersion,
          [WEBHOOK_HEADERS.eventId]: delivery.eventId,
          [WEBHOOK_HEADERS.eventType]: delivery.eventType,
          [WEBHOOK_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)),
        },
        body,
        signal: controller.signal,
      });
      httpStatus = res.status;
      try {
        const text = await res.text();
        responseBody = text.length > 512 ? text.slice(0, 512) : text;
      } catch {
        responseBody = null;
      }
    } catch (err) {
      networkError = (err as Error).message.slice(0, 256);
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - started;
    const succeeded = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

    if (succeeded) {
      await prisma.$transaction([
        prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            state: 'SUCCEEDED',
            httpStatus,
            responseBody,
            latencyMs,
            completedAt: new Date(),
          },
        }),
        prisma.webhookSubscription.update({
          where: { id: sub.id },
          data: { failureCount: 0, lastSuccessAt: new Date() },
        }),
      ]);
      return;
    }

    const attempt = delivery.attempt;
    const exceeded = attempt >= MAX_ATTEMPTS;
    const nextAttemptAt = exceeded
      ? null
      : new Date(Date.now() + backoffFor(attempt));
    const failReason =
      networkError ?? `http_${httpStatus ?? 'unknown'}`;

    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          state: exceeded ? 'DEAD_LETTERED' : 'FAILED_RETRY',
          httpStatus,
          responseBody: responseBody ?? networkError,
          latencyMs,
          attempt: attempt + 1,
          nextAttemptAt,
          deadLetteredAt: exceeded ? new Date() : undefined,
        },
      }),
      prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: {
          failureCount: { increment: 1 },
          lastFailureAt: new Date(),
          lastFailureReason: failReason.slice(0, 256),
        },
      }),
    ]);

    if (exceeded) {
      logger.error('webhook_delivery_dead_lettered', {
        operatorId: delivery.operatorId,
        subscriptionId: sub.id,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        attempts: attempt,
      });
    }
  }

  /** Re-queue a dead-lettered delivery. Returns true if anything changed. */
  async replay(deliveryId: string): Promise<boolean> {
    const d = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!d || d.state !== 'DEAD_LETTERED') return false;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        state: 'FAILED_RETRY',
        attempt: 1,
        nextAttemptAt: new Date(),
        deadLetteredAt: null,
        completedAt: null,
      },
    });
    return true;
  }
}

export const webhookDispatcher = new WebhookDispatcher();
