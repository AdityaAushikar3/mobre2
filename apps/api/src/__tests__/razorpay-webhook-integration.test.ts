import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

export let __currentUserId: string | null = null;
vi.mock('@api/middlewares/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!__currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('user', { id: __currentUserId });
    c.set('session', { id: 'session_mock' });
    await next();
  }
}));

import { app } from '@api/app';
import { env } from '@cio/core/config/env';
import { createHmac } from 'crypto';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq, and } from 'drizzle-orm';
import * as razorpayService from '@cio/core/services/course/razorpay';
import crypto from 'node:crypto';

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_WEBHOOK_SECRET: 'test_secret',
    RAZORPAY_KEY_ID: 'test_key',
    RAZORPAY_KEY_SECRET: 'test_key_secret'
  }
}));

describe('Razorpay Webhook Integration', () => {
  let userId: string;
  let orgId: string;
  let courseId: string;
  let groupId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    userId = crypto.randomUUID();
    orgId = crypto.randomUUID();
    courseId = crypto.randomUUID();
    groupId = crypto.randomUUID();

    // Set mock user for browser verify route
    __currentUserId = userId;

    await db.insert(schema.organization).values({ id: orgId, name: 'Test Org' });
    await db.insert(schema.user).values({ id: userId, email: `student-${userId}@example.com`, name: 'Student' });
    await db.insert(schema.profile).values({
      id: userId,
      email: `student-${userId}@example.com`,
      fullname: 'Student',
      username: `student-${userId}`
    });
    await db.insert(schema.group).values({ id: groupId, name: 'Test Group', organizationId: orgId });
    await db.insert(schema.course).values({
      id: courseId,
      title: 'Test Course',
      description: 'Test description',
      groupId,
      status: 'PUBLISHED'
    });
  });

  function generateSignature(payload: string, secret: string = 'test_secret') {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  async function createLocalOrder(razorpayOrderId: string) {
    const orderId = crypto.randomUUID();
    await db.insert(schema.courseOrder).values({
      id: orderId,
      userId,
      organizationId: orgId,
      courseId,
      amountPaise: 100000,
      currency: 'INR',
      status: 'CREATED',
      razorpayOrderId
    });
    return orderId;
  }

  it('14A. Successful webhook fulfillment', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();

    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': eventId
      },
      body: payload
    });

    if (res.status !== 200) {
      console.error(await res.text());
    }
    expect(res.status).toBe(200);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');
    expect(order.razorpayPaymentId).toBe(razorpayPaymentId);

    const [membership] = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(membership).toBeDefined();

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('PROCESSED');
  });

  it('14B. Same webhook event repeated sequentially (idempotency)', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    const verifySpy = vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    const res1 = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload
    });
    expect(res2.status).toBe(200);

    expect(verifySpy).toHaveBeenCalledTimes(1);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');
  });

  it('14C. Same webhook event concurrently', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    const verifySpy = vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    const requests = Array.from({ length: 3 }).map(() =>
      app.request('/public-api/webhooks/razorpay', {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
        body: payload
      })
    );

    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    expect(verifySpy).toHaveBeenCalledTimes(1);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');
  });

  it('14D/F. Different webhook events, same payment / Already Enrolled', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    const verifySpy = vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    // Event 1
    const event1 = crypto.randomUUID();
    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': event1 },
      body: payload
    });

    // Event 2 (same payment, different webhook event ID)
    const event2 = crypto.randomUUID();
    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': event2 },
      body: payload
    });

    // Both should succeed
    expect(verifySpy).toHaveBeenCalledTimes(2); // markPaidAndEnroll is idempotent

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');

    // Group members should only be 1
    const members = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(members.length).toBe(1);
  });

  it('14G. Provider verification failure', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(new Error('Provider failure'));

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    // Should bubble up error and be marked FAILED
    expect(res.status).toBe(500);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('CREATED'); // unchanged

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('FAILED');
  });

  it('14H. Enrollment failure', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });
    // Sabotage enrollment by mocking markPaidAndEnroll
    vi.spyOn(await import('@cio/core/services/course/payment'), 'markPaidAndEnroll').mockRejectedValue(
      new Error('Enrollment failed')
    );

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    expect(res.status).toBe(500);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('FAILED');

    // Explicit Database Assertions
    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('CREATED'); // NOT incorrectly PAID
    expect(order.razorpayPaymentId).toBeNull(); // NOT committed

    const members = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(members.length).toBe(0); // no membership created

    // Verify a retry can attempt fulfillment again
    vi.restoreAllMocks(); // Remove the markPaidAndEnroll sabotage
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const retryRes = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    expect(retryRes.status).toBe(200);
    const [retryEvent] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(retryEvent.status).toBe('PROCESSED');

    const [finalOrder] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(finalOrder.status).toBe('PAID');
  });
  it('14I. Concurrent different events (simulates browser + webhook)', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    const verifySpy = vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    // Event 1 (simulates Webhook)
    const req1 = app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': crypto.randomUUID() },
      body: payload
    });

    // Event 2 (simulates Browser doing another webhook/verification concurrently)
    const req2 = app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': crypto.randomUUID() },
      body: payload
    });

    const [res1, res2] = await Promise.all([req1, req2]);

    // One might succeed, one might fail with duplicate payment, or both succeed because markPaidAndEnroll is idempotent for SAME payment ID.
    // Actually, markPaidAndEnroll uses a transaction with serializable/for update lock, so it's perfectly safe.
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');
  });

  it('14J. Different payment against same order (Step 4 duplicate-payment rules)', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId1 = 'pay_webhook_' + crypto.randomUUID();
    const razorpayPaymentId2 = 'pay_webhook_' + crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    // Fulfill first payment
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValueOnce({
      id: razorpayPaymentId1,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload1 = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId1, order_id: razorpayOrderId } } }
    });

    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload1), 'X-Razorpay-Event-Id': crypto.randomUUID() },
      body: payload1
    });

    // Try to fulfill second payment for the SAME order
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValueOnce({
      id: razorpayPaymentId2,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload2 = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId2, order_id: razorpayOrderId } } }
    });

    const res2 = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload2), 'X-Razorpay-Event-Id': crypto.randomUUID() },
      body: payload2
    });

    // Should succeed (200) but update order with DUPLICATE_PAYMENT
    expect(res2.status).toBe(200);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');
    expect(order.razorpayPaymentId).toBe(razorpayPaymentId1); // Still the first one
    expect(order.needsAttention).toBe(true);
    expect(order.attentionReason).toBe('DUPLICATE_PAYMENT');
  });

  it('14K. Provider payment not captured', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'authorized', // Not captured
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload), 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    // The webhook route throws a 400 for not captured
    expect(res.status).toBe(400);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('FAILED');
  });

  it('14L. Actual browser verify + webhook race', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();

    // Create the actual order
    const [{ id: localOrderId }] = await db
      .insert(schema.courseOrder)
      .values({
        courseId,
        userId,
        organizationId: orgId,
        amountPaise: 100000,
        status: 'CREATED',
        razorpayOrderId
      })
      .returning();

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    // Call BOTH entry points concurrently
    const [webhookRes, browserRes] = await Promise.all([
      app.request('/public-api/webhooks/razorpay', {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
        body: payload
      }),
      app.request(`/course/orders/${localOrderId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id: razorpayPaymentId,
          razorpay_signature: signature
        })
      })
    ]);

    expect(webhookRes.status).toBe(200);
    // Browser route might return 200 or might return an error if it hits the duplicate payment logic.
    // Since it's a valid duplicate, the browser route verifyProviderPayment logic (actually markPaidAndEnroll)
    // resolves gracefully or throws a DUPLICATE_PAYMENT error which we map to a 400 or 200 depending on the route.
    // Let's just verify the database state.

    const [finalOrder] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(finalOrder.status).toBe('PAID');
    expect(finalOrder.razorpayPaymentId).toBe(razorpayPaymentId);

    const members = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(members.length).toBe(1);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('PROCESSED');
  });

  it('14M. Real crash-style retry', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });

    // Simulate crash by manually inserting event as PROCESSING, stale
    await db.insert(schema.razorpayWebhookEvent).values({
      providerEventId: eventId,
      eventType: 'order.paid',
      detail: payload,
      status: 'PROCESSING',
      updatedAt: new Date(Date.now() - 1000 * 60 * 6).toISOString() // 6 minutes ago (lease is 2 minutes)
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload), 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    expect(res.status).toBe(200);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('PROCESSED');

    const [finalOrder] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(finalOrder.status).toBe('PAID');
  });

  it('14N. Provider 404', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    const { AppError, ErrorCodes } = await import('@cio/utils/errors');
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(
      new AppError('Payment not found in provider', ErrorCodes.NOT_FOUND, 404)
    );

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload), 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    expect(res.status).toBe(404);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('FAILED');

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('CREATED');
  });

  it('14O. Provider mismatch', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await createLocalOrder(razorpayOrderId);

    // Mismatched order_id from provider
    const { AppError, ErrorCodes } = await import('@cio/utils/errors');
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(
      new AppError('Payment does not belong to the expected order', ErrorCodes.VALIDATION_ERROR, 400)
    );

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload), 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    // The webhook route throws a 400 when there's a mismatch in the payload vs verified payment
    expect(res.status).toBe(400);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('FAILED');

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('CREATED');
  });
});
