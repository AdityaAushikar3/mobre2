import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimRazorpayWebhookEvent, resolveRazorpayWebhookEvent, WEBHOOK_LEASE_MS } from '../webhook-claim';
import { db } from '@cio/db/drizzle';
import { razorpayWebhookEvent } from '@cio/db/schema';
import { eq, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Webhook Claim Module', () => {
  let createdEventIds: string[] = [];

  function createEventId() {
    const id = `evt_test_${crypto.randomUUID()}`;
    createdEventIds.push(id);
    return id;
  }

  beforeEach(() => {
    createdEventIds = [];
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(async () => {
    if (createdEventIds.length > 0) {
      await db.delete(razorpayWebhookEvent).where(inArray(razorpayWebhookEvent.providerEventId, createdEventIds));
    }
    vi.useRealTimers();
  });

  it('claims a new event successfully', async () => {
    const eventId = createEventId();
    const res = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res.status).toBe('newly_claimed');

    const [row] = await db.select().from(razorpayWebhookEvent).where(eq(razorpayWebhookEvent.providerEventId, eventId));
    expect(row).toBeDefined();
    expect(row.status).toBe('PROCESSING');
  });

  it('returns in_progress for fresh PROCESSING event', async () => {
    const eventId = createEventId();
    await claimRazorpayWebhookEvent(eventId, 'order.paid');
    const res = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res.status).toBe('in_progress');
  });

  it('reclaims stale PROCESSING event', async () => {
    const eventId = createEventId();
    const res1 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res1.status).toBe('newly_claimed');

    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    const res2 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res2.status).toBe('newly_claimed');
    // Ensure it's the same event ID in DB
    expect(res2.eventId).toBe((res1 as any).eventId);
  });

  it('returns duplicate_done for PROCESSED event', async () => {
    const eventId = createEventId();
    const res1 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    await resolveRazorpayWebhookEvent((res1 as any).eventId, 'PROCESSED', undefined, (res1 as any).processingLeaseId);

    const res2 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res2.status).toBe('duplicate_done');
  });

  it('returns duplicate_done for IGNORED event', async () => {
    const eventId = createEventId();
    const res1 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    await resolveRazorpayWebhookEvent((res1 as any).eventId, 'IGNORED', undefined, (res1 as any).processingLeaseId);

    const res2 = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(res2.status).toBe('duplicate_done');
  });

  it('prevents stale worker from overwriting state (Lease Ownership Race Fix)', async () => {
    const eventId = createEventId();
    // 1. Worker A claims event
    const resA = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(resA.status).toBe('newly_claimed');
    const tokenA = (resA as any).processingLeaseId;
    const dbEventId = (resA as any).eventId;

    // 2. Make the lease stale
    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    // 3. Worker B reclaims event
    const resB = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    expect(resB.status).toBe('newly_claimed');
    const tokenB = (resB as any).processingLeaseId;
    expect(tokenB).not.toBe(tokenA);

    // 4. Worker B resolves event as PROCESSED
    const resolveB = await resolveRazorpayWebhookEvent(dbEventId, 'PROCESSED', 'Done by B', tokenB);
    expect(resolveB.status).toBe('resolved');

    // 5. Worker A later attempts to resolve same event as FAILED using token A
    const resolveA = await resolveRazorpayWebhookEvent(dbEventId, 'FAILED', 'Failed by A', tokenA);
    expect(resolveA.status).toBe('lost_lease');

    // 6. Final DB state remains PROCESSED
    const [row] = await db.select().from(razorpayWebhookEvent).where(eq(razorpayWebhookEvent.id, dbEventId));
    expect(row.status).toBe('PROCESSED');
    expect(row.detail).toBe('Done by B');
  });

  it('prevents stale worker from overwriting state (B fails, A cannot process)', async () => {
    const eventId = createEventId();
    // 1. Worker A claims event
    const resA = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    const tokenA = (resA as any).processingLeaseId;
    const dbEventId = (resA as any).eventId;

    // 2. Make the lease stale
    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    // 3. Worker B reclaims event
    const resB = await claimRazorpayWebhookEvent(eventId, 'order.paid');
    const tokenB = (resB as any).processingLeaseId;

    // 4. Worker B resolves event as FAILED
    await resolveRazorpayWebhookEvent(dbEventId, 'FAILED', 'Failed by B', tokenB);

    // 5. Worker A later attempts to resolve same event as PROCESSED using token A
    const resolveA = await resolveRazorpayWebhookEvent(dbEventId, 'PROCESSED', 'Done by A', tokenA);
    expect(resolveA.status).toBe('lost_lease');

    // 6. Final DB state remains FAILED
    const [row] = await db.select().from(razorpayWebhookEvent).where(eq(razorpayWebhookEvent.id, dbEventId));
    expect(row.status).toBe('FAILED');
    expect(row.detail).toBe('Failed by B');
  });
});
