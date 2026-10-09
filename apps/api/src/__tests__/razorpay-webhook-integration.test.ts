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
import { eq, and, inArray } from 'drizzle-orm';
import * as razorpayService from '@cio/core/services/course/razorpay';
import crypto from 'node:crypto';
import * as Sentry from '@sentry/node';

import { AppError } from '@api/utils/errors';
import * as apiPaymentService from '@api/services/course/payment';
import * as corePaymentService from '@cio/core/services/course/payment';

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_WEBHOOK_SECRET: 'test_secret',
    RAZORPAY_KEY_ID: 'test_key',
    RAZORPAY_KEY_SECRET: 'test_key_secret'
  }
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  init: vi.fn(),
  flush: vi.fn().mockResolvedValue(true)
}));

describe('Razorpay Webhook Integration', () => {
  let createdEventIds: string[] = [];
  function createEventId() {
    const id = crypto.randomUUID();
    createdEventIds.push(id);
    return id;
  }
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

  afterEach(async () => {
    // Delete in reverse FK order to maintain isolation
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, userId));
    await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.userId, userId));
    await db.delete(schema.course).where(eq(schema.course.id, courseId));
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.profile).where(eq(schema.profile.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));

    // Clean up exact webhook events created during the test
    if (createdEventIds.length > 0) {
      await db
        .delete(schema.razorpayWebhookEvent)
        .where(inArray(schema.razorpayWebhookEvent.providerEventId, createdEventIds));
    }
    createdEventIds = [];
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
    const eventId = createEventId();

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
    const eventId = createEventId();
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
    const eventId = createEventId();
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
    const statuses = responses.map((r) => r.status);
    expect(statuses).toContain(200);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);

    expect(verifySpy).toHaveBeenCalledTimes(1);

    const [order] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(order.status).toBe('PAID');

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event.status).toBe('PROCESSED');
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
    const event1 = createEventId();
    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': event1 },
      body: payload
    });

    // Event 2 (same payment, different webhook event ID)
    const event2 = createEventId();
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

    const events = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(and(eq(schema.razorpayWebhookEvent.razorpayOrderId, razorpayOrderId)));

    const e1 = events.find((e) => e.providerEventId === event1);
    const e2 = events.find((e) => e.providerEventId === event2);
    expect(e1?.status).toBe('PROCESSED');
    expect(e2?.status).toBe('PROCESSED');
  });

  it('14G. Provider verification failure', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = createEventId();
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
    const eventId = createEventId();
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
    expect(finalOrder.razorpayPaymentId).toBe(razorpayPaymentId);

    const finalMembers = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(finalMembers.length).toBe(1);
  });
  it('14I. Concurrent different webhook events', async () => {
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
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': createEventId() },
      body: payload
    });

    // Event 2 (another concurrent webhook delivery)
    const req2 = app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': createEventId() },
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
      headers: { 'X-Razorpay-Signature': generateSignature(payload1), 'X-Razorpay-Event-Id': createEventId() },
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
      headers: { 'X-Razorpay-Signature': generateSignature(payload2), 'X-Razorpay-Event-Id': createEventId() },
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
    const eventId = createEventId();
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
    const eventId = createEventId();

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

    const webhookPayload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const webhookSignature = generateSignature(webhookPayload, 'test_secret');
    const browserSignature = generateSignature(`${razorpayOrderId}|${razorpayPaymentId}`, 'test_key_secret');

    // Call BOTH entry points concurrently
    const [webhookRes, browserRes] = await Promise.all([
      app.request('/public-api/webhooks/razorpay', {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': webhookSignature, 'X-Razorpay-Event-Id': eventId },
        body: webhookPayload
      }),
      app.request(`/course/orders/${localOrderId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id: razorpayPaymentId,
          razorpay_signature: browserSignature
        })
      })
    ]);

    expect(webhookRes.status).toBe(200);
    expect(browserRes.status).toBe(200);

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
    const eventId = createEventId();
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

    // 1. Worker A claims event
    const { claimRazorpayWebhookEvent } = await import('@cio/core/services/course/webhook-claim');
    const claimResult = await claimRazorpayWebhookEvent(eventId, 'order.paid', razorpayOrderId, razorpayPaymentId);
    expect(claimResult.status).toBe('newly_claimed');

    // 2. Worker A fulfills payment (markPaidAndEnroll succeeds)
    const { markPaidAndEnroll } = await import('@cio/core/services/course/payment');
    const { enrollStudentInCourseTransaction } = await import('@api/services/course/payment');

    const verifiedPayment = {
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    };
    await markPaidAndEnroll(verifiedPayment, enrollStudentInCourseTransaction);

    // 3 & 4. Worker A crashes before marking event PROCESSED -> Time passes, lease becomes stale
    // (We manually simulate this by just advancing the updatedAt timestamp, leaving status as PROCESSING)
    await db
      .update(schema.razorpayWebhookEvent)
      .set({ updatedAt: new Date(Date.now() - 1000 * 60 * 6).toISOString() })
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));

    // Order should be PAID, but event still PROCESSING
    const [intermediateOrder] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(intermediateOrder.status).toBe('PAID');

    const [intermediateEvent] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(intermediateEvent.status).toBe('PROCESSING');

    // 5. Worker B reclaims and retries
    const resB = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'X-Razorpay-Signature': generateSignature(payload), 'X-Razorpay-Event-Id': eventId },
      body: payload
    });

    expect(resB.status).toBe(200);

    // 6. Worker B successfully marks event PROCESSED
    const [finalEvent] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(finalEvent.status).toBe('PROCESSED');

    // 7. Ensure idempotent fulfillment (still PAID, one enrollment)
    const [finalOrder] = await db
      .select()
      .from(schema.courseOrder)
      .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
    expect(finalOrder.status).toBe('PAID');

    const members = await db
      .select()
      .from(schema.groupmember)
      .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
    expect(members.length).toBe(1); // Exactly one enrollment
  });

  it('14N. Provider 404', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = createEventId();
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
    const eventId = createEventId();
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

  it('14P. Provider 502 (Generic provider failure reaches webhook)', async () => {
    const razorpayOrderId = 'order_webhook_' + crypto.randomUUID();
    const razorpayPaymentId = 'pay_webhook_' + crypto.randomUUID();
    const eventId = createEventId();
    await createLocalOrder(razorpayOrderId);

    const { AppError, ErrorCodes } = await import('@cio/utils/errors');
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(
      new AppError('Failed to verify payment with provider', ErrorCodes.INTERNAL_ERROR, 502)
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

    // Webhook should return 502 which bubbles out
    expect(res.status).toBe(502);

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

  it('14Q. Reject request when Content-Length exceeds limit (413)', async () => {
    const payload = JSON.stringify({ event: 'order.paid' }) + ' '.repeat(1024 * 1024 + 10);
    const signature = generateSignature(payload);

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': createEventId(),
        'Content-Length': String(payload.length)
      },
      body: payload
    });

    expect(res.status).toBe(413);
  });

  it('14R. Reject request when streamed body exceeds limit (413)', async () => {
    const payload = JSON.stringify({ event: 'order.paid' }) + ' '.repeat(1024 * 1024 + 10);
    const signature = generateSignature(payload);

    // Use a ReadableStream to prevent Content-Length from being set automatically
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': createEventId(),
        'Transfer-Encoding': 'chunked'
      },
      body: stream as any,
      // @ts-ignore
      duplex: 'half'
    });

    expect(res.status).toBe(413);
  });

  it('14S. Reject request when signature contains invalid non-hex trailing characters', async () => {
    const payload = JSON.stringify({ event: 'order.paid' });
    const validSignature = generateSignature(payload);
    const eventId = createEventId();

    // We add 'gg' which is not valid hex to the end of a valid 64-char hex string.
    const invalidSignature = validSignature + 'gg';

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': invalidSignature,
        'X-Razorpay-Event-Id': eventId
      },
      body: payload
    });

    expect(res.status).toBe(401);

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));
    expect(event).toBeUndefined(); // Should not even be claimed
  });

  it('14T. Sanitizes error detail and does not leak sensitive information', async () => {
    const razorpayOrderId = 'order_test_sanitization';
    const razorpayPaymentId = 'pay_test_sanitization';
    const eventId = createEventId();

    await createLocalOrder(razorpayOrderId);

    // Simulate an unexpected internal error with sensitive information
    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(
      new Error('DB connection to internal-host:5432 failed; password=SECRET_VALUE')
    );

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

    // The error bubbles up to the error handler
    expect(res.status).toBe(500);

    const responseBody = await res.text();
    expect(responseBody).not.toContain('SECRET_VALUE');
    expect(responseBody).not.toContain('internal-host');

    const [event] = await db
      .select()
      .from(schema.razorpayWebhookEvent)
      .where(eq(schema.razorpayWebhookEvent.providerEventId, eventId));

    expect(event.status).toBe('FAILED');
    expect(event.detail).not.toContain('SECRET_VALUE');
    expect(event.detail).not.toContain('internal-host');
    expect(event.detail).toBe('Webhook processing failed'); // sanitized, not raw error

    expect(Sentry.captureException).toHaveBeenCalled();
    const capturedError = vi.mocked(Sentry.captureException).mock.calls[0][0] as Error;
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError.message).not.toContain('SECRET_VALUE');
    expect(capturedError.message).not.toContain('internal-host');
    expect(capturedError.stack).not.toContain('SECRET_VALUE');
    expect(capturedError.stack).not.toContain('internal-host');
    expect(capturedError.message).toContain('[Sanitized] Webhook processing failed');
  });

  it('14U. Sanitizes AppError and does not leak sensitive information to Sentry', async () => {
    vi.clearAllMocks();
    const razorpayOrderId = 'order_test_sanitization_apperror';
    const razorpayPaymentId = 'pay_test_sanitization_apperror';
    const eventId = createEventId();

    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockRejectedValue(
      new AppError('DB password=SECRET_VALUE host=internal-host', 'INTERNAL_ERROR', 500)
    );

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': eventId
      },
      body: payload
    });

    expect(Sentry.captureException).toHaveBeenCalled();
    const capturedError = vi.mocked(Sentry.captureException).mock.calls[0][0] as Error;
    expect(capturedError.message).not.toContain('SECRET_VALUE');
    expect(capturedError.message).not.toContain('internal-host');
    expect(capturedError.stack).not.toContain('SECRET_VALUE');
    expect(capturedError.stack).not.toContain('internal-host');
  });

  it('14V. Sanitizes post-commit side-effect errors in logs', async () => {
    vi.clearAllMocks();
    const razorpayOrderId = 'order_test_sanitization_side_effect';
    const razorpayPaymentId = 'pay_test_sanitization_side_effect';
    const eventId = createEventId();

    await createLocalOrder(razorpayOrderId);

    vi.spyOn(razorpayService, 'verifyProviderPayment').mockResolvedValue({
      id: razorpayPaymentId,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 100000,
      currency: 'INR'
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Force an effect to fail
    vi.spyOn(corePaymentService, 'markPaidAndEnroll').mockResolvedValue({
      handled: true,
      alreadyEnrolled: false,
      order: { id: 'order_123', razorpayOrderId: 'order_123' } as any,
      effects: [{ type: 'TEST_EFFECT' }]
    });

    vi.spyOn(apiPaymentService, 'runPostCommitSideEffects').mockRejectedValue(
      new Error('Failed effect due to db password=SECRET_VALUE')
    );

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: razorpayPaymentId, order_id: razorpayOrderId } } }
    });
    const signature = generateSignature(payload);

    await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': eventId
      },
      body: payload
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logCalls = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join(' ');
    expect(logCalls).not.toContain('SECRET_VALUE');
  });

  it('14W. Rejects an otherwise valid webhook with a mathematically perfect HMAC but the wrong secret', async () => {
    vi.clearAllMocks();
    const eventId = createEventId();

    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_123', order_id: 'order_123' } } }
    });

    // Generate valid structure but wrong secret
    const wrongSignature = crypto.createHmac('sha256', 'wrong_secret').update(payload).digest('hex');

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': wrongSignature,
        'X-Razorpay-Event-Id': eventId
      },
      body: payload
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
  });
});
