import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import { markPaidAndEnroll, type VerifiedPayment, EnrollmentFailedError } from '@cio/core/services/course/payment';

describe('Course Payment Processing State Machine (Cases A-F)', () => {
  const orgId = crypto.randomUUID();
  let groupId: string;

  beforeAll(async () => {
    await db.insert(schema.organization).values({
      id: orgId,
      name: 'Test Org for Verify',
      slug: `verify-org-${Date.now()}`
    });

    const [group] = await db
      .insert(schema.group)
      .values({
        organizationId: orgId,
        name: 'Test Course Group Verify'
      })
      .returning();
    groupId = group.id;
  });

  afterAll(async () => {
    await db.delete(schema.group).where(eq(schema.group.id, groupId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  describe('Core MarkPaidAndEnroll function', () => {
    const courseId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    let razorpayOrderId: string;

    beforeEach(async () => {
      razorpayOrderId = `order_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

      await db.insert(schema.user).values({
        id: userId,
        email: `student-verify-${Date.now()}@test.com`,
        name: 'Test Verify Student',
        emailVerified: true
      });
      await db.insert(schema.profile).values({
        id: userId,
        email: `student-verify-${Date.now()}@test.com`,
        fullname: 'Test Verify Student',
        username: `student_verify_${Date.now()}`
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

    it('Case E: Normal successful payment and enrollment', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        status: 'CREATED',
        needsAttention: false
      });

      const payment: VerifiedPayment = {
        id: 'pay_xyz123',
        razorpayOrderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollFn = vi.fn().mockResolvedValue({ someEffect: true });

      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(result.alreadyEnrolled).toBe(false);
      expect(result.effects).toEqual({ someEffect: true });
      expect(enrollFn).toHaveBeenCalled();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.status).toBe('PAID');
      expect(order.razorpayPaymentId).toBe('pay_xyz123');
      expect(order.needsAttention).toBe(false);
    });

    it('Case A: Order is already PAID, same payment (Idempotency)', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        razorpayPaymentId: 'pay_xyz123',
        status: 'PAID',
        needsAttention: false
      });

      const payment: VerifiedPayment = {
        id: 'pay_xyz123', // Same payment
        razorpayOrderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(enrollFn).not.toHaveBeenCalled();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.needsAttention).toBe(false);
    });

    it('Case A: Order is already PAID, DIFFERENT payment (Needs attention)', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        razorpayPaymentId: 'pay_xyz123',
        status: 'PAID',
        needsAttention: false
      });

      const payment: VerifiedPayment = {
        id: 'pay_abc999', // Different payment
        razorpayOrderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(enrollFn).not.toHaveBeenCalled();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.needsAttention).toBe(true);
      expect(order.attentionReason).toBe('DUPLICATE_PAYMENT');
      expect(order.attentionPaymentIds).toContain('pay_abc999');
    });

    it('Case C: Amount Mismatch', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        status: 'CREATED',
        needsAttention: false
      });

      const payment: VerifiedPayment = {
        id: 'pay_xyz123',
        razorpayOrderId,
        status: 'captured',
        amountPaise: 40000, // Mismatch
        currency: 'INR'
      };

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(enrollFn).not.toHaveBeenCalled();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.status).toBe('CREATED');
      expect(order.needsAttention).toBe(true);
      expect(order.attentionReason).toBe('AMOUNT_MISMATCH');
    });

    it('Case D: Student already enrolled', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        status: 'CREATED',
        needsAttention: false
      });

      // Simulate student already in group
      await db.insert(schema.groupmember).values({
        groupId: groupId,
        roleId: 2,
        profileId: userId,
        email: `student-verify-${Date.now()}@test.com`
      });

      const payment: VerifiedPayment = {
        id: 'pay_xyz123',
        razorpayOrderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(result.alreadyEnrolled).toBe(true);
      expect(enrollFn).not.toHaveBeenCalled();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.status).toBe('PAID');
      expect(order.needsAttention).toBe(true);
      expect(order.attentionReason).toBe('ALREADY_ENROLLED');
    });

    it('Case F: Enrollment Failure', async () => {
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: razorpayOrderId,
        status: 'CREATED',
        needsAttention: false
      });

      const payment: VerifiedPayment = {
        id: 'pay_xyz123',
        razorpayOrderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollFn = vi.fn().mockRejectedValue(new Error('Simulated DB failure'));

      await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow('Payment verified but enrollment failed');

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));
      expect(order.status).toBe('CREATED');
      expect(order.razorpayPaymentId).toBeNull();
      expect(order.needsAttention).toBe(true);
      expect(order.attentionReason).toBe('ENROLLMENT_FAILED');
    });
  });
});
