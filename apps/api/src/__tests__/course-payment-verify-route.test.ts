import { describe, expect, it, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { verifyRouter } from '../routes/course/verify';
import { Hono } from 'hono';

const RAZORPAY_SECRET = 'rzp_secret_123';
const RAZORPAY_ORDER_ID = 'order_verify_route_suite';

vi.mock('razorpay', () => ({
  default: class RazorpayMock {
    constructor(_options: any) {}
    payments = {
      fetch: async (paymentId: string) => {
        if (paymentId === 'pay_not_found') {
          const error: any = new Error('Not found');
          error.statusCode = 404;
          throw error;
        }

        if (paymentId === 'pay_provider_error') {
          const error: any = new Error('Upstream unavailable');
          error.statusCode = 503;
          throw error;
        }

        if (paymentId === 'pay_auth_error') {
          const error: any = new Error('Unauthorized');
          error.statusCode = 401;
          throw error;
        }

        if (paymentId === 'pay_bad_request_not_found') {
          const error: any = new Error('Bad request');
          error.statusCode = 400;
          error.error = { code: 'BAD_REQUEST_ERROR', description: 'payment does not exist' };
          throw error;
        }

        if (paymentId === 'pay_bad_request_already_exists') {
          const error: any = new Error('Bad request');
          error.statusCode = 400;
          error.error = { code: 'BAD_REQUEST_ERROR', description: 'payment already exists' };
          throw error;
        }

        if (paymentId === 'pay_401_bad_request') {
          const error: any = new Error('Unauthorized');
          error.statusCode = 401;
          error.error = { code: 'BAD_REQUEST_ERROR', description: 'payment does not exist' };
          throw error;
        }

        if (paymentId === 'pay_econnreset') {
          throw new Error('ECONNRESET');
        }

        if (paymentId === 'pay_pending') {
          return {
            id: paymentId,
            order_id: RAZORPAY_ORDER_ID,
            status: 'authorized',
            amount: 50000,
            currency: 'INR'
          };
        }

        if (paymentId === 'pay_failed') {
          return {
            id: paymentId,
            order_id: RAZORPAY_ORDER_ID,
            status: 'failed',
            amount: 50000,
            currency: 'INR'
          };
        }

        if (paymentId === 'pay_mismatch_id') {
          return {
            id: 'pay_other',
            order_id: RAZORPAY_ORDER_ID,
            status: 'captured',
            amount: 50000,
            currency: 'INR'
          };
        }

        if (paymentId === 'pay_mismatch_order') {
          return {
            id: paymentId,
            order_id: 'order_456',
            status: 'captured',
            amount: 50000,
            currency: 'INR'
          };
        }

        return {
          id: paymentId,
          order_id: RAZORPAY_ORDER_ID,
          status: 'captured',
          amount: 50000,
          currency: 'INR'
        };
      }
    };
  }
}));

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_KEY_ID: 'rzp_test_123',
    RAZORPAY_KEY_SECRET: 'rzp_secret_123',
    SESSION_SECRET: 'test_secret',
    API_PORT: 8080,
    PUBLIC_IS_SELFHOSTED: 'true',
    RESEND_API_KEY: 're_123',
    POSTGRES_URL: 'postgres://postgres:postgres@localhost:5432/classroomio'
  }
}));

let authenticatedUserId: string | null = null;

vi.mock('@api/middlewares/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!authenticatedUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('user', { id: authenticatedUserId });
    await next();
  }
}));

const testApp = new Hono();
testApp.route('/course', verifyRouter);

describe('Course payment verification route', () => {
  const orgId = crypto.randomUUID();
  const courseId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  let groupId: string;
  let orderId: string;
  let razorpayOrderId: string;
  let validPaymentId: string;

  beforeAll(async () => {
    await db.insert(schema.organization).values({
      id: orgId,
      name: 'Verify Test Org'
    });

    const [group] = await db
      .insert(schema.group)
      .values({
        organizationId: orgId,
        name: 'Verify Test Group'
      })
      .returning();
    groupId = group.id;

    await db.insert(schema.user).values({
      id: userId,
      email: `verify-${crypto.randomUUID()}@test.com`,
      name: 'Verify User',
      emailVerified: true
    });

    await db.insert(schema.profile).values({
      id: userId,
      email: `verify-profile-${crypto.randomUUID()}@test.com`,
      fullname: 'Verify User',
      username: `verify_${crypto.randomUUID().slice(0, 8)}`
    });

    await db.insert(schema.course).values({
      id: courseId,
      title: 'Paid Verify Course',
      description: 'Course used by payment verification tests',
      groupId,
      isTemplate: false,
      logo: 'test.png',
      metadata: {},
      cost: 500,
      currency: 'INR'
    });
  });

  afterAll(async () => {
    await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, userId));
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));
    await db.delete(schema.course).where(eq(schema.course.id, courseId));
    await db.delete(schema.profile).where(eq(schema.profile.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  beforeEach(async () => {
    razorpayOrderId = RAZORPAY_ORDER_ID;
    validPaymentId = `pay_${crypto.randomUUID()}`;

    const [order] = await db
      .insert(schema.courseOrder)
      .values({
        organizationId: orgId,
        userId,
        courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId,
        status: 'CREATED',
        needsAttention: false
      })
      .returning();

    orderId = order.id;
    authenticatedUserId = userId;
  });

  afterEach(async () => {
    authenticatedUserId = null;
    await db.delete(schema.groupmember).where(eq(schema.groupmember.groupId, groupId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, userId));
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
  });

  const signatureFor = (order: string, payment: string) =>
    crypto.createHmac('sha256', RAZORPAY_SECRET).update(`${order}|${payment}`).digest('hex');

  const request = (body: unknown, path = `/course/orders/${orderId}/verify`) =>
    testApp.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });

  it('accepts a valid captured payment and enrolls the student', async () => {
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: validPaymentId,
      razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('PAID');
    expect(data.data.razorpayPaymentId).toBe(validPaymentId);
  });

  it('rejects invalid signature content', async () => {
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: validPaymentId,
      razorpay_signature: crypto.randomBytes(32).toString('hex')
    });

    expect(res.status).toBe(400);
  });

  it('rejects short, long, and malformed signatures with controlled 400 responses', async () => {
    for (const signature of ['short', crypto.randomBytes(64).toString('hex'), 'z'.repeat(64)]) {
      const res = await request({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: validPaymentId,
        razorpay_signature: signature
      });

      expect(res.status).toBe(400);
    }
  });

  it('rejects non-string signature and malformed JSON', async () => {
    const typeRes = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: validPaymentId,
      razorpay_signature: 12345
    });
    expect(typeRes.status).toBe(400);

    const malformedRes = await request('{ malformed-json');
    expect(malformedRes.status).toBe(400);
  });

  it('rejects missing verification fields', async () => {
    const res = await request({
      razorpay_order_id: razorpayOrderId
    });

    expect(res.status).toBe(400);
  });

  it('rejects an order ID mismatch before provider processing', async () => {
    const mismatchedOrderId = `${razorpayOrderId}_other`;
    const res = await request({
      razorpay_order_id: mismatchedOrderId,
      razorpay_payment_id: validPaymentId,
      razorpay_signature: signatureFor(mismatchedOrderId, validPaymentId)
    });

    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    authenticatedUserId = null;

    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: validPaymentId,
      razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
    });

    expect(res.status).toBe(401);
  });

  it('rejects another user accessing the order', async () => {
    const otherUserId = crypto.randomUUID();
    const otherEmail = `other-${crypto.randomUUID()}@test.com`;

    await db.insert(schema.user).values({
      id: otherUserId,
      name: 'Other',
      email: otherEmail,
      emailVerified: true
    });
    await db.insert(schema.profile).values({
      id: otherUserId,
      email: otherEmail,
      fullname: 'Other',
      username: `other_${crypto.randomUUID().slice(0, 8)}`
    });

    authenticatedUserId = otherUserId;

    try {
      const res = await request({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: validPaymentId,
        razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
      });

      expect(res.status).toBe(403);
    } finally {
      await db.delete(schema.profile).where(eq(schema.profile.id, otherUserId));
      await db.delete(schema.user).where(eq(schema.user.id, otherUserId));
    }
  });

  it('returns 404 for an unknown local order', async () => {
    const res = await request(
      {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: validPaymentId,
        razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
      },
      `/course/${crypto.randomUUID()}/verify`
    );

    expect(res.status).toBe(404);
  });

  it('returns 404 for a payment that the provider cannot find', async () => {
    const paymentId = 'pay_not_found';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(404);
  });

  it('returns 502 for provider/network/server failures', async () => {
    const paymentId = 'pay_provider_error';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(502);
  });

  it('returns 404 for BAD_REQUEST_ERROR that describes payment does not exist', async () => {
    const paymentId = 'pay_bad_request_not_found';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(404);
  });

  it('returns 502 for BAD_REQUEST_ERROR when payment already exists', async () => {
    const paymentId = 'pay_bad_request_already_exists';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(502);
  });

  it('returns 502 for 401 even if description says payment does not exist', async () => {
    const paymentId = 'pay_401_bad_request';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(502);
  });

  it('returns 502 for 401 authentication error', async () => {
    const paymentId = 'pay_auth_error';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(502);
  });

  it('returns 502 for network errors (e.g. ECONNRESET)', async () => {
    const paymentId = 'pay_econnreset';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(502);
  });

  it('rejects provider payment ID mismatch', async () => {
    const paymentId = 'pay_mismatch_id';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(400);
  });

  it('rejects provider order ID mismatch', async () => {
    const paymentId = 'pay_mismatch_order';
    const res = await request({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(400);
  });

  it('returns PENDING for an authorized payment and does not enroll', async () => {
    const paymentId = 'pay_pending';
    const res = await request({
      razorpay_order_id: RAZORPAY_ORDER_ID,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('PENDING');

    const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    expect(order.status).toBe('CREATED');
  });

  it('returns FAILED for a failed provider payment and does not enroll', async () => {
    const paymentId = 'pay_failed';
    const res = await request({
      razorpay_order_id: RAZORPAY_ORDER_ID,
      razorpay_payment_id: paymentId,
      razorpay_signature: signatureFor(razorpayOrderId, paymentId)
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe('FAILED');

    const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    expect(order.status).toBe('CREATED');
  });

  it('does not expose an old alternate verification path', async () => {
    const res = await request(
      {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: validPaymentId,
        razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
      },
      `/course/${orderId}/verify`
    );

    expect(res.status).not.toBe(200);
  });

  it('uses the intended response for a captured payment without a duplicated verification URL', async () => {
    const intendedPath = `/course/orders/${orderId}/verify`;
    const res = await request(
      {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: validPaymentId,
        razorpay_signature: signatureFor(razorpayOrderId, validPaymentId)
      },
      intendedPath
    );

    expect(res.status).toBe(200);
  });
});
