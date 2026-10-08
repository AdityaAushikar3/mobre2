import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimRazorpayWebhookEvent, resolveRazorpayWebhookEvent, WEBHOOK_LEASE_MS } from '../webhook-claim';
import { db } from '@cio/db/drizzle';
import { razorpayWebhookEvent } from '@cio/db/schema';
import { eq } from 'drizzle-orm';

describe('Webhook Claim Module', () => {
  beforeEach(async () => {
    await db.delete(razorpayWebhookEvent);
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
});
