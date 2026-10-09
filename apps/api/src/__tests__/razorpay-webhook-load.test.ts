import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_WEBHOOK_SECRET: 'test_secret',
    RAZORPAY_KEY_ID: 'test_key',
    RAZORPAY_KEY_SECRET: 'test_key_secret'
  }
}));
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { app } from '../app';
import crypto from 'node:crypto';
import * as razorpayService from '@cio/core/services/course/razorpay';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';

describe('Webhook Load & Concurrency Validation', () => {
  const WEBHOOK_SECRET = 'test_secret';
  let orgId: string;
  let userId: string;
  let courseId: string;
  let orderId: string;
  let rzpOrderId: string;
  let rzpPaymentId: string;
  let sharedEvtId: string;

  beforeAll(async () => {
    orgId = crypto.randomUUID();
    userId = crypto.randomUUID();
    courseId = crypto.randomUUID();
    rzpOrderId = `order_${crypto.randomUUID()}`;
    rzpPaymentId = `pay_${crypto.randomUUID()}`;
    sharedEvtId = `evt_shared_${crypto.randomUUID()}`;

    const groupId = crypto.randomUUID();

    await db.insert(schema.organization).values({ id: orgId, name: 'Load Test Org' });
    await db.insert(schema.group).values({ id: groupId, name: 'Load Test Group', organizationId: orgId });
    const uniqueEmail = `load_user_${userId}@example.com`;
    await db.insert(schema.user).values({
      id: userId,
      email: uniqueEmail,
      name: 'Load User'
    });
    await db.insert(schema.profile).values({
      id: userId,
      email: uniqueEmail,
      fullname: 'Load User',
      username: `load_user_${userId}`
    });
    await db.insert(schema.course).values({
      id: courseId,
      groupId: groupId,
      title: 'Load Test Course',
      description: 'Load test course description',
      slug: `load-course-${crypto.randomUUID()}`,
      cost: 10000,
      isTemplate: false
    });
  });

  afterAll(async () => {
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.organizationId, orgId));
    await db.delete(schema.razorpayWebhookEvent).where(eq(schema.razorpayWebhookEvent.razorpayOrderId, rzpOrderId));
    await db.delete(schema.course).where(eq(schema.course.id, courseId));
    await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, userId));
    await db.delete(schema.profile).where(eq(schema.profile.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.group).where(eq(schema.group.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    orderId = crypto.randomUUID();
    await db.insert(schema.courseOrder).values({
      id: orderId,
      organizationId: orgId,
      userId: userId,
      courseId: courseId,
      amountPaise: 10000,
      currency: 'INR',
      razorpayOrderId: rzpOrderId,
      status: 'CREATED'
    });
  });

  afterEach(async () => {
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    await db.delete(schema.razorpayWebhookEvent).where(eq(schema.razorpayWebhookEvent.razorpayOrderId, rzpOrderId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.organizationId, orgId));
  });

  it('handles bounded concurrent webhook deliveries safely', async () => {
    const payload = {
      event: 'order.paid',
      account_id: 'acc_load',
      contains: ['payment', 'order'],
      payload: {
        order: { entity: { id: rzpOrderId, amount: 10000, amount_paid: 10000, status: 'paid' } },
        payment: { entity: { id: rzpPaymentId, amount: 10000, status: 'captured' } }
      }
    };
    const body = JSON.stringify(payload);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      status: 'captured',
      id: rzpPaymentId,
      razorpayOrderId: rzpOrderId,
      amountPaise: 10000,
      currency: 'INR'
    } as any);

    const CONCURRENCY = 15;
    const startTime = Date.now();

    const requests = Array.from({ length: CONCURRENCY }).map((_, i) => {
      // Half requests send exact same event id, half send different event ids
      const evtId = i % 2 === 0 ? sharedEvtId : `evt_load_${i}_${crypto.randomUUID()}`;
      const payloadWithEvt = {
        ...payload,
        account_id: 'acc_load',
        contains: ['payment', 'order']
      };

      const sig = createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payloadWithEvt)).digest('hex');

      return app.request('/public-api/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'X-Razorpay-Event-Id': evtId,
          'X-Razorpay-Signature': sig,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payloadWithEvt)
      });
    });

    const responses = await Promise.all(requests);
    const duration = Date.now() - startTime;

    const statuses = responses.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 200).length;
    const retryCount = statuses.filter((s) => s === 409).length;

    for (const r of responses) {
      if (r.status !== 200 && r.status !== 409) {
        console.error('Failed request:', r.status, await r.json());
      }
    }

    console.log(`Load Test Results:`);
    console.log(`- Total Requests: ${CONCURRENCY}`);
    console.log(`- Success (200): ${successCount}`);
    console.log(`- Retry/Conflict (409): ${retryCount}`);
    console.log(`- Duration: ${duration}ms`);

    // Invariants Check
    const [finalOrder] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    expect(finalOrder.status).toBe('PAID');
    expect(finalOrder.razorpayPaymentId).toBe(rzpPaymentId);

    // 8 provider-verification calls are expected for 8 distinct claimed event IDs, while duplicate deliveries of the shared event ID should be deduplicated. The intended outcome is a single effective course enrollment.
    expect(razorpayService.verifyProviderPayment).toHaveBeenCalledTimes(8);

    // Membership should only be created once
    const members = await db
      .select()
      .from(schema.organizationmember)
      .where(eq(schema.organizationmember.profileId, userId));
    expect(members.length).toBe(1);

    const groupMembers = await db.select().from(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
    expect(groupMembers.length).toBe(1);

    const events = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.razorpayOrderId, rzpOrderId));
    expect(events.length).toBe(8);
    events.forEach((e) => expect(e.status).toBe('PROCESSED'));

    // Total success responses should be equal to the number of successful processing + idempotently returned 200s
    expect(successCount + retryCount).toBe(CONCURRENCY);
  });
});
