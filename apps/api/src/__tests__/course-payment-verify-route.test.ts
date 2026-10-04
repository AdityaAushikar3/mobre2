import { describe, expect, it, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import app from '@api/app'; // Or the entry point to get the router
import crypto from 'node:crypto';

// We need to test the route behavior, including signature verification and mock Razorpay.
// Let's create an integration test similar to purchase-route.test.ts

vi.mock('razorpay', () => {
  return {
    default: class RazorpayMock {
      constructor(options: any) {}
      payments = {
        fetch: async (paymentId: string) => {
          if (paymentId === 'pay_not_found') {
            throw new Error('Not found');
          }
          if (paymentId === 'pay_pending') {
            return {
              id: paymentId,
              order_id: 'order_123',
              status: 'authorized', // Not captured
              amount: 50000,
              currency: 'INR'
            };
          }
          if (paymentId === 'pay_mismatch') {
            return {
              id: paymentId,
              order_id: 'order_456', // Mismatch!
              status: 'captured',
              amount: 50000,
              currency: 'INR'
            };
          }
          return {
            id: paymentId,
            order_id: 'order_123',
            status: 'captured',
            amount: 50000,
            currency: 'INR'
          };
        }
      };
    }
  };
});

vi.mock('@cio/core/config/env', () => {
  return {
    env: {
      RAZORPAY_KEY_ID: 'rzp_test_123',
      RAZORPAY_KEY_SECRET: 'rzp_secret_123',
      SESSION_SECRET: 'test_secret',
      API_PORT: 8080,
      PUBLIC_IS_SELFHOSTED: 'true',
      RESEND_API_KEY: 're_123',
      POSTGRES_URL: 'postgres://postgres:postgres@localhost:5432/classroomio'
    }
  };
});

vi.mock('@api/middlewares/auth', () => {
  return {
    authMiddleware: async (c: any, next: any) => {
      await next();
    }
  };
});

// Since we can't easily start the whole express/hono app here if it's complex,
// we might mock the auth middleware and route directly, or just rely on standard app request.
// Let's use the actual route if possible, we just need a valid token.
// A simpler way for a route test if app is not easily importable is just to assume it passes through.
// Actually, I will mock the auth for standard app requests.
// Wait, we can use a helper or just create a minimal hono app here to test the router.
import { verifyRouter } from '../routes/course/verify';
import { Hono } from 'hono';

const testApp = new Hono();
const testUserId = crypto.randomUUID();
const testUserEmail = `test_verify_${Date.now()}@test.com`;
testApp.use('*', async (c, next) => {
  c.set('user', { id: testUserId, email: testUserEmail });
  await next();
});
testApp.route('/course', verifyRouter);

describe('Verify Route API', () => {
  const orgId = crypto.randomUUID();
  let groupId: string;
  let orderId: string;
  const courseId = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(schema.organization).values({
      id: orgId,
      name: 'Test Org',
      slug: `verify-route-org-${Date.now()}`
    });

    const [group] = await db.insert(schema.group).values({ organizationId: orgId, name: 'Group' }).returning();
    groupId = group.id;

    await db.insert(schema.user).values({ id: testUserId, email: testUserEmail, name: 'Test', emailVerified: true });
    await db
      .insert(schema.profile)
      .values({ id: testUserId, email: testUserEmail, fullname: 'Test', username: `usr_${Date.now()}` });

    await db.insert(schema.course).values({
      id: courseId,
      title: 'Course',
      description: 'Course',
      groupId: groupId,
      isTemplate: false,
      logo: 'test.png',
      metadata: {},
      cost: 500,
      currency: 'INR'
    });
  });

  afterAll(async () => {
    await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, testUserId));
    await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, testUserId));
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));
    await db.delete(schema.course).where(eq(schema.course.id, courseId));
    await db.delete(schema.profile).where(eq(schema.profile.id, testUserId));
    await db.delete(schema.user).where(eq(schema.user.id, testUserId));
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  beforeEach(async () => {
    const [order] = await db
      .insert(schema.courseOrder)
      .values({
        organizationId: orgId,
        userId: testUserId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_123',
        status: 'CREATED',
        needsAttention: false
      })
      .returning();
    orderId = order.id;
  });

  afterEach(async () => {
    await db.delete(schema.courseOrder).where(eq(schema.courseOrder.id, orderId));
    await db.delete(schema.groupmember).where(eq(schema.groupmember.groupId, groupId));
  });

  const getSignature = (orderId: string, paymentId: string) => {
    return crypto.createHmac('sha256', 'rzp_secret_123').update(`${orderId}|${paymentId}`).digest('hex');
  };

  it('verifies a valid payment and enrolls', async () => {
    const res = await testApp.request(`/course/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_123',
        razorpay_payment_id: 'pay_xyz',
        razorpay_signature: getSignature('order_123', 'pay_xyz')
      })
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('PAID');
    expect(data.data.razorpayPaymentId).toBe('pay_xyz');
  });

  it('rejects invalid signature', async () => {
    const invalidSignature = crypto.randomBytes(32).toString('hex');
    const res = await testApp.request(`/course/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_123',
        razorpay_payment_id: 'pay_xyz',
        razorpay_signature: invalidSignature
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects mismatching order_id', async () => {
    const res = await testApp.request(`/course/${orderId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_mismatch',
        razorpay_payment_id: 'pay_xyz',
        razorpay_signature: getSignature('order_mismatch', 'pay_xyz')
      })
    });

    expect(res.status).toBe(400);
  });
});
