import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimRazorpayWebhookEvent, resolveRazorpayWebhookEvent, WEBHOOK_LEASE_MS } from '../webhook-claim';
import { db } from '@cio/db/drizzle';
import { razorpayWebhookEvent } from '@cio/db/schema';
import { eq, like } from 'drizzle-orm';

describe('Webhook Claim Module', () => {
  beforeEach(async () => {
    await db.delete(razorpayWebhookEvent).where(like(razorpayWebhookEvent.providerEventId, 'evt_test%'));
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a new event successfully', async () => {
    const res = await claimRazorpayWebhookEvent('evt_test1', 'order.paid');
    expect(res.status).toBe('newly_claimed');

    const [row] = await db
      .select()
      .from(razorpayWebhookEvent)
      .where(eq(razorpayWebhookEvent.providerEventId, 'evt_test1'));
    expect(row).toBeDefined();
    expect(row.status).toBe('PROCESSING');
  });

  it('returns in_progress for fresh PROCESSING event', async () => {
    await claimRazorpayWebhookEvent('evt_test2', 'order.paid');
    const res = await claimRazorpayWebhookEvent('evt_test2', 'order.paid');
    expect(res.status).toBe('in_progress');
  });

  it('reclaims stale PROCESSING event', async () => {
    const res1 = await claimRazorpayWebhookEvent('evt_test3', 'order.paid');
    expect(res1.status).toBe('newly_claimed');

    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    const res2 = await claimRazorpayWebhookEvent('evt_test3', 'order.paid');
    expect(res2.status).toBe('newly_claimed');
    // Ensure it's the same event ID in DB
    expect(res2.eventId).toBe((res1 as any).eventId);
  });

  it('returns duplicate_done for PROCESSED event', async () => {
    const res1 = await claimRazorpayWebhookEvent('evt_test4', 'order.paid');
    await resolveRazorpayWebhookEvent((res1 as any).eventId, 'PROCESSED');

    const res2 = await claimRazorpayWebhookEvent('evt_test4', 'order.paid');
    expect(res2.status).toBe('duplicate_done');
  });

  it('returns duplicate_done for IGNORED event', async () => {
    const res1 = await claimRazorpayWebhookEvent('evt_test5', 'order.paid');
    await resolveRazorpayWebhookEvent((res1 as any).eventId, 'IGNORED');

    const res2 = await claimRazorpayWebhookEvent('evt_test5', 'order.paid');
    expect(res2.status).toBe('duplicate_done');
  });

  it('prevents stale worker from overwriting state (Lease Ownership Race Fix)', async () => {
    // 1. Worker A claims event
    const resA = await claimRazorpayWebhookEvent('evt_test6', 'order.paid');
    expect(resA.status).toBe('newly_claimed');
    const tokenA = (resA as any).processingLeaseId;
    const eventId = (resA as any).eventId;

    // 2. Make the lease stale
    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    // 3. Worker B reclaims event
    const resB = await claimRazorpayWebhookEvent('evt_test6', 'order.paid');
    expect(resB.status).toBe('newly_claimed');
    const tokenB = (resB as any).processingLeaseId;
    expect(tokenB).not.toBe(tokenA);

    // 4. Worker B resolves event as PROCESSED
    const resolveB = await resolveRazorpayWebhookEvent(eventId, 'PROCESSED', 'Done by B', tokenB);
    expect(resolveB.status).toBe('resolved');

    // 5. Worker A later attempts to resolve same event as FAILED using token A
    const resolveA = await resolveRazorpayWebhookEvent(eventId, 'FAILED', 'Failed by A', tokenA);
    expect(resolveA.status).toBe('lost_lease');

    // 6. Final DB state remains PROCESSED
    const [row] = await db.select().from(razorpayWebhookEvent).where(eq(razorpayWebhookEvent.id, eventId));
    expect(row.status).toBe('PROCESSED');
    expect(row.detail).toBe('Done by B');
  });

  it('prevents stale worker from overwriting state (B fails, A cannot process)', async () => {
    // 1. Worker A claims event
    const resA = await claimRazorpayWebhookEvent('evt_test7', 'order.paid');
    const tokenA = (resA as any).processingLeaseId;
    const eventId = (resA as any).eventId;

    // 2. Make the lease stale
    vi.advanceTimersByTime(WEBHOOK_LEASE_MS + 1000);

    // 3. Worker B reclaims event
    const resB = await claimRazorpayWebhookEvent('evt_test7', 'order.paid');
    const tokenB = (resB as any).processingLeaseId;

    // 4. Worker B resolves event as FAILED
    await resolveRazorpayWebhookEvent(eventId, 'FAILED', 'Failed by B', tokenB);

    // 5. Worker A later attempts to resolve same event as PROCESSED using token A
    const resolveA = await resolveRazorpayWebhookEvent(eventId, 'PROCESSED', 'Done by A', tokenA);
    expect(resolveA.status).toBe('lost_lease');

    // 6. Final DB state remains FAILED
    const [row] = await db.select().from(razorpayWebhookEvent).where(eq(razorpayWebhookEvent.id, eventId));
    expect(row.status).toBe('FAILED');
    expect(row.detail).toBe('Failed by B');
  });
});
