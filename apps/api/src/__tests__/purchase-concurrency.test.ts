import { describe, expect, it, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import { createCoursePurchase } from '@cio/core/services/course/purchase';
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
      name: 'Test Org',
      slug: `test-org-${Date.now()}`
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

    it('razorpayPaymentId != NULL is NOT reused (gets fresh order)', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_failed_${Date.now()}`,
        razorpayPaymentId: 'pay_xyz123',
        status: 'CREATED',
        needsAttention: false
      });

      const res = await createCoursePurchase(courseId, userId, orgId);
      expect(res.razorpayOrderId).not.toBe(`order_failed_${Date.now()}`);
      expect(res.razorpayOrderId.startsWith('order_')).toBe(true);
    });

    it('needsAttention=true is NOT reused', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: `order_attn_${Date.now()}`,
        status: 'CREATED',
        needsAttention: true
      });

      const res = await createCoursePurchase(courseId, userId, orgId);
      expect(res.razorpayOrderId).not.toBe(`order_attn_${Date.now()}`);
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

      it('accepts valid price ₹999 -> 99900 paise', async () => {
        await db.update(schema.course).set({ cost: 999 }).where(eq(schema.course.id, courseId));
        const res = await createCoursePurchase(courseId, userId, orgId);
        expect(res.amount).toBe(99900);
      });
    });
  });
});
