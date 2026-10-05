import { Hono } from 'hono';
import { env } from 'hono/adapter';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { courseRouter } from '../routes/course/course';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import Razorpay from 'razorpay';
import * as paymentService from '../services/course/payment';

// Mock Razorpay globally so we can intercept it
vi.mock('razorpay', () => {
  return {
    default: vi.fn()
  };
});

// Mock environment
vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_KEY_SECRET: 'test_secret',
    RAZORPAY_KEY_ID: 'test_key'
  }
}));

// Mock authMiddleware since verifyRouter imports it directly
let __currentUserId: string | null = null;
vi.mock('@api/middlewares/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!__currentUserId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('user', { id: __currentUserId });
    await next();
  }
}));

const buildProductionApp = () => {
  const app = new Hono();
  app.route('/course', courseRouter);
  return app;
};

describe('PRODUCTION INTEGRATION — POST /course/orders/:orderId/verify (via actual courseRouter)', () => {
  let RZP_ORDER_ID: string;
  let RZP_PAY_OK: string;
  let RZP_PAY_ENROLL: string;
  let orgId: string;
  let studentUserId: string;
  let otherUserId: string;
  let courseId: string;
  let groupId: string;
  let orderId: string;

  const sign = (order: string, payment: string) => {
    return crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'test_secret')
      .update(`${order}|${payment}`)
      .digest('hex');
  };

  beforeEach(async () => {
    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    process.env.RAZORPAY_KEY_ID = 'test_key';

    RZP_ORDER_ID = `prod_rzp_order_${crypto.randomUUID()}`;
    RZP_PAY_OK = `prod_pay_ok_${crypto.randomUUID()}`;
    RZP_PAY_ENROLL = `prod_pay_enroll_${crypto.randomUUID()}`;

    // Mock Razorpay instance for this test run to return the dynamic RZP_ORDER_ID
    vi.mocked(Razorpay).mockImplementation(
      () =>
        ({
          payments: {
            fetch: vi.fn().mockImplementation((paymentId) => {
              if (paymentId === RZP_PAY_OK || paymentId === RZP_PAY_ENROLL) {
                return Promise.resolve({
                  id: paymentId,
                  order_id: RZP_ORDER_ID,
                  status: 'captured',
                  amount: 50000,
                  currency: 'INR'
                });
              }
              return Promise.reject({ statusCode: 404 });
            })
          }
        }) as any
    );

    orgId = crypto.randomUUID();
    studentUserId = crypto.randomUUID();
    otherUserId = crypto.randomUUID();
    courseId = crypto.randomUUID();
    groupId = crypto.randomUUID();

    await db.insert(schema.organization).values({ id: orgId, name: 'Prod Org', slug: `prod-${orgId}` });
    await db
      .insert(schema.user)
      .values({ id: studentUserId, name: 'Student', email: `student_${studentUserId}@example.com` });
    await db
      .insert(schema.user)
      .values({ id: otherUserId, name: 'Other User', email: `other_${otherUserId}@example.com` });
    await db
      .insert(schema.profile)
      .values({
        id: studentUserId,
        fullname: 'Student',
        username: `student_${studentUserId}`,
        email: `student_${studentUserId}@example.com`
      });
    await db
      .insert(schema.profile)
      .values({
        id: otherUserId,
        fullname: 'Other User',
        username: `other_${otherUserId}`,
        email: `other_${otherUserId}@example.com`
      });
    await db.insert(schema.group).values({ id: groupId, organizationId: orgId, name: 'Prod Group' });
    await db
      .insert(schema.course)
      .values({ id: courseId, organizationId: orgId, groupId, title: 'Prod Course', description: 'Description' });

    const [order] = await db
      .insert(schema.courseOrder)
      .values({
        organizationId: orgId,
        userId: studentUserId,
        courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: RZP_ORDER_ID,
        status: 'CREATED',
        needsAttention: false
      })
      .returning();
    orderId = order.id;
    __currentUserId = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __currentUserId = null;
    await db.delete(schema.groupmember).where(eq(schema.groupmember.groupId, groupId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, studentUserId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, otherUserId));
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));
    await db.delete(schema.course).where(eq(schema.course.id, courseId));
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.profile).where(eq(schema.profile.id, studentUserId));
    await db.delete(schema.profile).where(eq(schema.profile.id, otherUserId));
    await db.delete(schema.user).where(eq(schema.user.id, studentUserId));
    await db.delete(schema.user).where(eq(schema.user.id, otherUserId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  it('1. Route matches at /course/orders/:orderId/verify and orderId is correctly extracted via c.req.param("orderId")', async () => {
    __currentUserId = studentUserId;
    const app = buildProductionApp();

    const fakeOrderId = crypto.randomUUID();
    const res = await app.request(`/course/orders/${fakeOrderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_OK,
        razorpay_signature: sign(RZP_ORDER_ID, RZP_PAY_OK)
      })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('2. Unauthenticated request returns 401 (auth middleware is active)', async () => {
    __currentUserId = null;
    const app = buildProductionApp();

    const res = await app.request(`/course/orders/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_OK,
        razorpay_signature: sign(RZP_ORDER_ID, RZP_PAY_OK)
      })
    });

    expect(res.status).toBe(401);
  });

  it('3. Authenticated student can verify their own order and reaches markPaidAndEnroll', async () => {
    __currentUserId = studentUserId;
    const app = buildProductionApp();

    const res = await app.request(`/course/orders/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_OK,
        razorpay_signature: sign(RZP_ORDER_ID, RZP_PAY_OK)
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    expect(order.status).toBe('PAID');
    expect(order.razorpayPaymentId).toBe(RZP_PAY_OK);
  });

  it("4. Another student's order is rejected with 403", async () => {
    const OTHER_RZP_ORDER_ID = `prod_rzp_order_other_${crypto.randomUUID()}`;
    const [otherOrder] = await db
      .insert(schema.courseOrder)
      .values({
        organizationId: orgId,
        userId: otherUserId,
        courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: OTHER_RZP_ORDER_ID,
        status: 'CREATED',
        needsAttention: false
      })
      .returning();

    __currentUserId = studentUserId;
    const app = buildProductionApp();

    const res = await app.request(`/course/orders/${otherOrder.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: OTHER_RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_OK,
        razorpay_signature: sign(OTHER_RZP_ORDER_ID, RZP_PAY_OK)
      })
    });

    expect(res.status).toBe(403);
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.id, otherOrder.id));
  });

  it('5. Successful payment reaches markPaidAndEnroll and student is enrolled in the group', async () => {
    __currentUserId = studentUserId;
    const app = buildProductionApp();

    const res = await app.request(`/course/orders/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_ENROLL,
        razorpay_signature: sign(RZP_ORDER_ID, RZP_PAY_ENROLL)
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('PAID');
    expect(data.data.razorpayPaymentId).toBe(RZP_PAY_ENROLL);

    const [gm] = await db.select().from(schema.groupmember).where(eq(schema.groupmember.groupId, groupId));
    expect(gm).toBeDefined();
    expect(gm.profileId).toBe(studentUserId);
  });

  it('6. Post-commit side-effect failure does not rollback enrollment or payment', async () => {
    __currentUserId = studentUserId;

    // Mock runPostCommitSideEffects to throw an error
    vi.spyOn(paymentService, 'runPostCommitSideEffects').mockRejectedValue(new Error('Simulated side-effect failure'));

    const app = buildProductionApp();
    const res = await app.request(`/course/orders/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER_ID,
        razorpay_payment_id: RZP_PAY_ENROLL,
        razorpay_signature: sign(RZP_ORDER_ID, RZP_PAY_ENROLL)
      })
    });

    // Request should still succeed
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('PAID');

    // Payment should be committed
    const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    expect(order.status).toBe('PAID');

    // Enrollment should be committed
    const [gm] = await db.select().from(schema.groupmember).where(eq(schema.groupmember.groupId, groupId));
    expect(gm).toBeDefined();
    expect(gm.profileId).toBe(studentUserId);
  });
});
