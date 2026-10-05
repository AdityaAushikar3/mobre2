import { describe, expect, it, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import { createCoursePurchase } from '@cio/core/services/course/purchase';
import { markPaidAndEnroll } from '@cio/core/services/course/payment';
import { ROLE } from '@cio/utils/constants';

// Mock Razorpay to simulate external network delay and deterministic behavior
vi.mock('razorpay', () => {
  return {
    default: class RazorpayMock {
      constructor(options: any) {}
      orders = {
        create: async (options: any) => {
          // Simulate 50ms network delay
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            id: `order_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
            amount: options.amount,
            currency: options.currency
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
      RAZORPAY_KEY_SECRET: 'rzp_secret_123'
    }
  };
});

describe('Course Purchase Concurrency & State', () => {
  const orgId = crypto.randomUUID();
  let groupId: string;

  beforeAll(async () => {
    await db.insert(schema.organization).values({
      id: orgId,
      name: 'Test Org'
    });

    const [group] = await db
      .insert(schema.group)
      .values({
        organizationId: orgId,
        name: 'Test Course Group'
      })
      .returning();
    groupId = group.id;
  });

  afterAll(async () => {
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  describe('Isolated tests', () => {
    const courseId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    beforeEach(async () => {
      await db.insert(schema.user).values({
        id: userId,
        email: `student-${Date.now()}@test.com`,
        name: 'Test Student',
        emailVerified: true
      });
      await db.insert(schema.profile).values({
        id: userId,
        email: `student-${Date.now()}@test.com`,
        fullname: 'Test Student',
        username: `student_${Date.now()}`
      });

      await db.insert(schema.course).values({
        id: courseId,
        title: 'Test Paid Course',
        description: 'Test Paid Course',
        groupId: groupId,
        isTemplate: false,
        logo: 'test.png',
        metadata: {},
        cost: 500, // 500 INR
        currency: 'INR'
      });
    });

    afterEach(async () => {
      await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
      await db.delete(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));
      await db.delete(schema.course).where(eq(schema.course.id, courseId));
      await db.delete(schema.profile).where(eq(schema.profile.id, userId));
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    });

    it('exactly ONE Razorpay order is created on concurrent purchase attempts', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }).map(() => createCoursePurchase(courseId, userId, orgId))
      );

      const successes = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(failures.length).toBe(0);
      expect(successes.length).toBe(5);

      const uniqueRazorpayOrderIds = new Set(successes.map((s) => s.value.razorpayOrderId));
      expect(uniqueRazorpayOrderIds.size).toBe(1);
    });

    it('CREATED ENROLLMENT_FAILED blocks purchase', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_failed_${Date.now()}`,
        status: 'CREATED',
        needsAttention: true,
        attentionReason: 'ENROLLMENT_FAILED'
      });

      await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
        'Your payment is being processed. Please contact support if this takes long.'
      );
    });

    it('CREATED ENROLLMENT_FAILED blocks purchase even if needsAttention is false', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_failed_${Date.now()}`,
        status: 'CREATED',
        needsAttention: false,
        attentionReason: 'ENROLLMENT_FAILED'
      });

      await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
        'Your payment is being processed. Please contact support if this takes long.'
      );
    });

    it('blocks new purchase when an existing CREATED order has a payment ID and needsAttention=true', async () => {
      const dynamicPaymentId = `pay_attn_${crypto.randomUUID()}`;
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_attn_${crypto.randomUUID()}`,
        razorpayPaymentId: dynamicPaymentId,
        status: 'CREATED',
        needsAttention: true,
        attentionReason: 'DUPLICATE_PAYMENT'
      });

      await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
        'Your previous payment requires attention. Please contact support before starting another purchase.'
      );
    });

    it('PAID ENROLLMENT_FAILED does NOT block as unresolved purchase', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_failed_${Date.now()}`,
        status: 'PAID',
        needsAttention: true,
        attentionReason: 'ENROLLMENT_FAILED'
      });

      const res = await createCoursePurchase(courseId, userId, orgId);
      expect(res.razorpayOrderId).toBeDefined();
    });

    it('valid reusable order is reused', async () => {
      const { razorpayOrderId: existingOrderId } = await createCoursePurchase(courseId, userId, orgId);
      const res = await createCoursePurchase(courseId, userId, orgId);
      expect(res.razorpayOrderId).toBe(existingOrderId);
    });

    it('razorpayPaymentId != NULL is NOT reused (gets a fresh order)', async () => {
      const blockedOrderId = `order_with_payment_${crypto.randomUUID()}`;

      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: blockedOrderId,
        razorpayPaymentId: 'pay_xyz123',
        status: 'CREATED',
        needsAttention: false
      });

      const res = await createCoursePurchase(courseId, userId, orgId);

      expect(res.razorpayOrderId).not.toBe(blockedOrderId);
      expect(res.razorpayOrderId.startsWith('order_')).toBe(true);
    });

    it('needsAttention=true is NOT reused', async () => {
      const attentionOrderId = `order_attn_${crypto.randomUUID()}`;

      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: attentionOrderId,
        status: 'CREATED',
        needsAttention: true
      });

      const res = await createCoursePurchase(courseId, userId, orgId);
      expect(res.razorpayOrderId).not.toBe(attentionOrderId);
    });

    it('reuses an older active CREATED order regardless of age', async () => {
      const oldOrderId = `order_old_${crypto.randomUUID()}`;
      const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: oldOrderId,
        status: 'CREATED',
        needsAttention: false,
        createdAt: oldDate,
        updatedAt: oldDate
      });

      const res = await createCoursePurchase(courseId, userId, orgId);

      expect(res.razorpayOrderId).toBe(oldOrderId);
    });

    it('price change creates a new order and supersedes older unpaid order', async () => {
      const first = await createCoursePurchase(courseId, userId, orgId);

      await db.update(schema.course).set({ cost: 600 }).where(eq(schema.course.id, courseId));

      const second = await createCoursePurchase(courseId, userId, orgId);

      expect(second.orderId).not.toBe(first.orderId);

      const [oldOrder] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, first.orderId));

      expect(oldOrder.status).toBe('CREATED');
      expect(oldOrder.razorpayPaymentId).toBeNull();
      expect(oldOrder.needsAttention).toBe(true);
      expect(oldOrder.attentionReason).toBe('AMOUNT_MISMATCH');

      const [newOrder] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, second.orderId));

      expect(newOrder.status).toBe('CREATED');
      expect(newOrder.needsAttention).toBe(false);
      expect(newOrder.amountPaise).toBe(60000);
    });

    it('a late payment for a superseded order is traceable but cannot enroll', async () => {
      const first = await createCoursePurchase(courseId, userId, orgId);

      await db.update(schema.course).set({ cost: 600 }).where(eq(schema.course.id, courseId));
      await createCoursePurchase(courseId, userId, orgId);

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(
        {
          id: `pay_superseded_${crypto.randomUUID()}`,
          razorpayOrderId: first.razorpayOrderId,
          status: 'captured',
          amountPaise: 50000,
          currency: 'INR'
        },
        enrollFn
      );

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('AMOUNT_MISMATCH');
      expect(result.order.razorpayPaymentId).toBeDefined();
      expect(enrollFn).not.toHaveBeenCalled();
    });

    it('already enrolled via groupmember rejects purchase', async () => {
      await db.insert(schema.groupmember).values({
        groupId: groupId,
        roleId: ROLE.STUDENT,
        profileId: userId,
        email: `student-${Date.now()}@test.com`
      });

      await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
        'You are already enrolled in this course'
      );
    });

    it('cross-organization course rejection', async () => {
      const otherOrgId = crypto.randomUUID();
      await db.insert(schema.organization).values({
        id: otherOrgId,
        name: 'Other Org'
      });

      await expect(createCoursePurchase(courseId, userId, otherOrgId)).rejects.toThrow(
        'Course not found in this organization'
      );

      await db.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
    });

    describe('Pricing validation', () => {
      it('rejects 0 cost', async () => {
        await db.update(schema.course).set({ cost: 0 }).where(eq(schema.course.id, courseId));
        await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
          'Course cost is below the minimum allowed for purchase'
        );
      });

      it('rejects negative cost', async () => {
        await db.update(schema.course).set({ cost: -50 }).where(eq(schema.course.id, courseId));
        await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
          'Course cost is below the minimum allowed for purchase'
        );
      });

      it('rejects PostgreSQL integer overflow (amountPaise > 2147483647)', async () => {
        // 22000000 is 2.2 billion paise, which exceeds 2147483647
        await db.update(schema.course).set({ cost: 22000000 }).where(eq(schema.course.id, courseId));
        await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
          'Course price exceeds maximum allowed value'
        );
      });

      it('rejects unsafe integer amount (amountPaise > Number.MAX_SAFE_INTEGER)', async () => {
        // Just having cost be MAX_SAFE_INTEGER / 100 will trigger the safe integer bound
        await db.update(schema.course).set({ cost: 90071992547410 }).where(eq(schema.course.id, courseId));
        await expect(createCoursePurchase(courseId, userId, orgId)).rejects.toThrow(
          'Course price is not a safe integer in paise'
        );
      });

      it('accepts valid price ₹999 -> 99900 paise', async () => {
        await db.update(schema.course).set({ cost: 999 }).where(eq(schema.course.id, courseId));
        const res = await createCoursePurchase(courseId, userId, orgId);
        expect(res.amount).toBe(99900);
      });
    });
  });
});
