import { db } from '@cio/db/drizzle';
import { razorpayWebhookEvent } from '@cio/db/schema';
import { eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';

export const WEBHOOK_LEASE_MS = 2 * 60 * 1000;

export type ClaimResult =
  | { status: 'newly_claimed'; eventId: string; processingLeaseId: string }
  | { status: 'in_progress'; eventId: string }
  | { status: 'duplicate_done'; eventId: string };

export async function claimRazorpayWebhookEvent(
  providerEventId: string,
  eventType: string,
  razorpayOrderId?: string,
  razorpayPaymentId?: string
): Promise<ClaimResult> {
  // 1. Try to insert new event
  const processingLeaseId = crypto.randomUUID();

  const [inserted] = await db
    .insert(razorpayWebhookEvent)
    .values({
      providerEventId,
      eventType,
      status: 'PROCESSING',
      razorpayOrderId,
      razorpayPaymentId,
      processingLeaseId
    })
    .onConflictDoNothing({ target: razorpayWebhookEvent.providerEventId })
    .returning();

  if (inserted) {
    return { status: 'newly_claimed', eventId: inserted.id, processingLeaseId: inserted.processingLeaseId! };
  }

  // 2. Already exists. Fetch it.
  const [existing] = await db
    .select()
    .from(razorpayWebhookEvent)
    .where(eq(razorpayWebhookEvent.providerEventId, providerEventId));

  if (!existing) {
    throw new Error('Webhook event disappeared after conflict');
  }

  if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
    return { status: 'duplicate_done', eventId: existing.id };
  }

  const now = new Date();
  const updatedAt = new Date(existing.updatedAt);
  const isStale = now.getTime() - updatedAt.getTime() > WEBHOOK_LEASE_MS;

  if (existing.status === 'PROCESSING' && !isStale) {
    return { status: 'in_progress', eventId: existing.id };
  }

  // 3. Stale PROCESSING or FAILED. Reclaim it atomically.
  const newLeaseId = crypto.randomUUID();
  const [updated] = await db
    .update(razorpayWebhookEvent)
    .set({
      status: 'PROCESSING',
      processingLeaseId: newLeaseId,
      updatedAt: now.toISOString()
    })
    .where(
      and(
        eq(razorpayWebhookEvent.id, existing.id),
        eq(razorpayWebhookEvent.status, existing.status),
        eq(razorpayWebhookEvent.updatedAt, existing.updatedAt) // Optimistic concurrency
      )
    )
    .returning();

  if (updated) {
    return { status: 'newly_claimed', eventId: updated.id, processingLeaseId: updated.processingLeaseId! };
  }

  // If update failed, another worker claimed it or it was processed
  return { status: 'in_progress', eventId: existing.id };
}

export async function resolveRazorpayWebhookEvent(
  eventId: string,
  status: 'PROCESSED' | 'IGNORED' | 'FAILED',
  detail: string | undefined,
  processingLeaseId: string
) {
  const conditions = [
    eq(razorpayWebhookEvent.id, eventId),
    eq(razorpayWebhookEvent.status, 'PROCESSING'),
    eq(razorpayWebhookEvent.processingLeaseId, processingLeaseId)
  ];

  const [updated] = await db
    .update(razorpayWebhookEvent)
    .set({
      status,
      detail,
      processingLeaseId: null, // Clear lease on terminal state
      updatedAt: new Date().toISOString()
    })
    .where(and(...conditions))
    .returning();

  if (!updated) {
    return { status: 'lost_lease' };
  }

  return { status: 'resolved' };
}
