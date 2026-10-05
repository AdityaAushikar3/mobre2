import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { and, eq } from 'drizzle-orm';
import { markPaidAndEnroll, type VerifiedPayment } from '@cio/core/services/course/payment';
import { enrollStudentInCourseTransaction } from '@api/services/course/payment';
import { ROLE } from '@cio/utils/constants';

describe('Course Payment Processing State Machine', () => {
  const orgId = crypto.randomUUID();
  let groupId: string;

  beforeAll(async () => {
    await db.insert(schema.organization).values({
      id: orgId,
      name: 'Test Org for Verify'
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

  describe('markPaidAndEnroll', () => {
    const courseId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    let razorpayOrderId: string;
    let userEmail: string;

    beforeEach(async () => {
      razorpayOrderId = `order_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      userEmail = `student-verify-${crypto.randomUUID()}@test.com`;

      await db.insert(schema.user).values({
        id: userId,
        email: userEmail,
        name: 'Test Verify Student',
        emailVerified: true
      });

      await db.insert(schema.profile).values({
        id: userId,
        email: userEmail,
        fullname: 'Test Verify Student',
        username: `student_verify_${crypto.randomUUID().slice(0, 8)}`
      });

      await db.insert(schema.course).values({
        id: courseId,
        title: 'Test Paid Course',
        description: 'Test Paid Course',
        groupId,
        isTemplate: false,
        logo: 'test.png',
        metadata: {},
        cost: 500,
        currency: 'INR'
      });
    });

    afterEach(async () => {
      await db.delete(schema.groupmember).where(eq(schema.groupmember.profileId, userId));
      await db.delete(schema.organizationmember).where(eq(schema.organizationmember.profileId, userId));
      await db.delete(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));
      await db.delete(schema.course).where(eq(schema.course.id, courseId));
      await db.delete(schema.profile).where(eq(schema.profile.id, userId));
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    });

    const makePayment = (overrides: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
      id: `pay_${crypto.randomUUID()}`,
      razorpayOrderId,
      status: 'captured',
      amountPaise: 50000,
      currency: 'INR',
      ...overrides
    });

    async function insertOrder(overrides: Partial<typeof schema.courseOrder.$inferInsert> = {}) {
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
          needsAttention: false,
          ...overrides
        })
        .returning();

      return order;
    }

    it('normal captured payment enrolls and marks order PAID', async () => {
      await insertOrder();

      const payment = makePayment();
      const enrollFn = vi.fn().mockResolvedValue({ someEffect: true });

      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(result.alreadyEnrolled).toBe(false);
      expect(result.effects).toEqual({ someEffect: true });
      expect(enrollFn).toHaveBeenCalledOnce();

      const [order] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));

      expect(order.status).toBe('PAID');
      expect(order.razorpayPaymentId).toBe(payment.id);
      expect(order.needsAttention).toBe(false);
    });

    it('PAID + same payment is an idempotent no-op', async () => {
      const payment = makePayment();
      await insertOrder({
        status: 'PAID',
        razorpayPaymentId: payment.id
      });

      const enrollFn = vi.fn();
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(enrollFn).not.toHaveBeenCalled();
      expect(result.order.status).toBe('PAID');
      expect(result.order.razorpayPaymentId).toBe(payment.id);
    });

    it('PAID + different payment preserves original and raises DUPLICATE_PAYMENT attention', async () => {
      await insertOrder({
        status: 'PAID',
        razorpayPaymentId: 'pay_original',
        needsAttention: false
      });

      const incoming = makePayment({ id: 'pay_duplicate' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await markPaidAndEnroll(incoming, vi.fn());

        expect(result.handled).toBe(true);
        expect(result.order.razorpayPaymentId).toBe('pay_original');
        expect(result.order.needsAttention).toBe(true);
        expect(result.order.attentionReason).toBe('DUPLICATE_PAYMENT');
        expect(result.order.attentionPaymentIds).toContain('pay_duplicate');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[DUPLICATE_PAYMENT]'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('CREATED + same existing payment is a locked idempotent no-op and never becomes PAID', async () => {
      await insertOrder({
        razorpayPaymentId: 'pay_existing',
        status: 'CREATED'
      });

      const result = await markPaidAndEnroll(makePayment({ id: 'pay_existing' }), vi.fn());

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.razorpayPaymentId).toBe('pay_existing');
    });

    it('CREATED + different existing payment preserves original and sets DUPLICATE_PAYMENT', async () => {
      await insertOrder({
        razorpayPaymentId: 'pay_existing',
        status: 'CREATED'
      });

      const incoming = makePayment({ id: 'pay_different' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await markPaidAndEnroll(incoming, vi.fn());

        expect(result.handled).toBe(true);
        expect(result.order.status).toBe('CREATED');
        expect(result.order.razorpayPaymentId).toBe('pay_existing');
        expect(result.order.needsAttention).toBe(true);
        expect(result.order.attentionReason).toBe('DUPLICATE_PAYMENT');
        expect(result.order.attentionPaymentIds).toContain('pay_different');
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('captured amount mismatch keeps order CREATED and raises AMOUNT_MISMATCH', async () => {
      await insertOrder();

      const payment = makePayment({ amountPaise: 40000 });
      const result = await markPaidAndEnroll(payment, vi.fn());

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('AMOUNT_MISMATCH');
      expect(result.order.razorpayPaymentId).toBe(payment.id);
      expect(result.order.attentionPaymentIds).toContain(payment.id);
    });

    it('captured currency mismatch keeps order CREATED and raises AMOUNT_MISMATCH', async () => {
      await insertOrder();

      const result = await markPaidAndEnroll(makePayment({ currency: 'USD' }), vi.fn());

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('AMOUNT_MISMATCH');
    });

    it('superseded attention-locked order records payment but cannot enroll or become PAID', async () => {
      await insertOrder({
        needsAttention: true,
        attentionReason: 'AMOUNT_MISMATCH'
      });

      const enrollFn = vi.fn();
      const payment = makePayment({ id: 'pay_superseded' });
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('AMOUNT_MISMATCH');
      expect(result.order.razorpayPaymentId).toBe('pay_superseded');
      expect(result.order.attentionPaymentIds).toContain('pay_superseded');
      expect(enrollFn).not.toHaveBeenCalled();
    });

    it('ENROLLMENT_FAILED is retryable and successful retry clears attention state', async () => {
      await insertOrder({
        needsAttention: true,
        attentionReason: 'ENROLLMENT_FAILED'
      });

      const failed = makePayment({ id: 'pay_failed_attempt' });
      await expect(
        markPaidAndEnroll(failed, vi.fn().mockRejectedValue(new Error('simulated enrollment failure')))
      ).rejects.toThrow('Payment verified but enrollment failed');

      const [failedOrder] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId));

      expect(failedOrder.status).toBe('CREATED');
      expect(failedOrder.razorpayPaymentId).toBeNull();
      expect(failedOrder.needsAttention).toBe(true);
      expect(failedOrder.attentionReason).toBe('ENROLLMENT_FAILED');

      const retry = await markPaidAndEnroll(
        makePayment({ id: 'pay_retry' }),
        vi.fn().mockResolvedValue({ retryEffect: true })
      );

      expect(retry.handled).toBe(true);
      expect(retry.order.status).toBe('PAID');
      expect(retry.order.razorpayPaymentId).toBe('pay_retry');
      expect(retry.order.needsAttention).toBe(false);
      expect(retry.order.attentionReason).toBeNull();
    });

    it('already-enrolled reconciliation preserves membership and creates missing org membership', async () => {
      await insertOrder();

      const [existingMembership] = await db
        .insert(schema.groupmember)
        .values({
          groupId,
          roleId: ROLE.STUDENT,
          profileId: userId,
          email: userEmail
        })
        .returning();

      const result = await markPaidAndEnroll(makePayment(), enrollStudentInCourseTransaction);

      expect(result.handled).toBe(true);
      expect(result.alreadyEnrolled).toBe(true);
      expect(result.order.status).toBe('PAID');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('ALREADY_ENROLLED');

      const [membershipAfter] = await db
        .select()
        .from(schema.groupmember)
        .where(eq(schema.groupmember.id, existingMembership.id));

      expect(membershipAfter.id).toBe(existingMembership.id);
      expect(membershipAfter.roleId).toBe(existingMembership.roleId);

      const [orgMembership] = await db
        .select()
        .from(schema.organizationmember)
        .where(
          and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
        );

      expect(orgMembership).toBeDefined();
      expect(result.effects).toBeDefined();
    });

    it('real enrollment transaction creates group and organization memberships', async () => {
      await insertOrder();

      const result = await markPaidAndEnroll(makePayment(), enrollStudentInCourseTransaction);

      expect(result.handled).toBe(true);
      expect(result.alreadyEnrolled).toBe(false);
      expect(result.order.status).toBe('PAID');

      const [groupMembership] = await db
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));

      const [orgMembership] = await db
        .select()
        .from(schema.organizationmember)
        .where(
          and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
        );

      expect(groupMembership).toBeDefined();
      expect(orgMembership).toBeDefined();
      expect(groupMembership.roleId).toBe(ROLE.STUDENT);
      expect(orgMembership.roleId).toBe(ROLE.STUDENT);
    });

    it('same user/course different orders are serialized so enrollment happens exactly once', async () => {
      const order1Id = `order_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const order2Id = `order_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

      await db.insert(schema.courseOrder).values([
        {
          organizationId: orgId,
          userId,
          courseId,
          amountPaise: 50000,
          currency: 'INR',
          razorpayOrderId: order1Id,
          status: 'CREATED',
          needsAttention: false
        },
        {
          organizationId: orgId,
          userId,
          courseId,
          amountPaise: 50000,
          currency: 'INR',
          razorpayOrderId: order2Id,
          status: 'CREATED',
          needsAttention: false
        }
      ]);

      const enroll1 = vi.fn().mockImplementation(async (tx, order, course) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return enrollStudentInCourseTransaction(tx, order, course);
      });
      const enroll2 = vi.fn().mockImplementation(async (tx, order, course) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return enrollStudentInCourseTransaction(tx, order, course);
      });

      const [result1, result2] = await Promise.all([
        markPaidAndEnroll(
          {
            id: `pay_${crypto.randomUUID()}`,
            razorpayOrderId: order1Id,
            status: 'captured',
            amountPaise: 50000,
            currency: 'INR'
          },
          enroll1
        ),
        markPaidAndEnroll(
          {
            id: `pay_${crypto.randomUUID()}`,
            razorpayOrderId: order2Id,
            status: 'captured',
            amountPaise: 50000,
            currency: 'INR'
          },
          enroll2
        )
      ]);

      expect([result1.alreadyEnrolled, result2.alreadyEnrolled].filter(Boolean)).toHaveLength(1);
      expect([result1.alreadyEnrolled, result2.alreadyEnrolled].filter((value) => !value)).toHaveLength(1);

      const memberships = await db
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));

      const orgMemberships = await db
        .select()
        .from(schema.organizationmember)
        .where(
          and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
        );

      expect(memberships).toHaveLength(1);
      expect(orgMemberships).toHaveLength(1);

      const orders = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.courseId, courseId));

      expect(orders.filter((order) => order.status === 'PAID')).toHaveLength(2);
      expect(new Set(orders.map((order) => order.razorpayPaymentId)).size).toBe(2);
    });

    it('SAME order + SAME payment concurrently is idempotent', async () => {
      const orderId = `order_same_${crypto.randomUUID()}`;
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: orderId,
        status: 'CREATED',
        needsAttention: false
      });

      const paymentId = `pay_${crypto.randomUUID()}`;
      const payment = {
        id: paymentId,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enroll1 = vi.fn().mockImplementation(async (tx, order, course) => {
        return enrollStudentInCourseTransaction(tx, order, course);
      });
      const enroll2 = vi.fn().mockImplementation(async (tx, order, course) => {
        return enrollStudentInCourseTransaction(tx, order, course);
      });

      const [result1, result2] = await Promise.all([
        markPaidAndEnroll(payment, enroll1),
        markPaidAndEnroll(payment, enroll2)
      ]);

      const [updatedOrder] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, orderId));
      expect(updatedOrder.status).toBe('PAID');
      expect(updatedOrder.razorpayPaymentId).toBe(paymentId);

      const memberships = await db
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
      expect(memberships).toHaveLength(1);

      const orgMemberships = await db
        .select()
        .from(schema.organizationmember)
        .where(
          and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
        );
      expect(orgMemberships).toHaveLength(1);
    });

    it('SAME order + DIFFERENT payments concurrently', async () => {
      const orderId = `order_diff_${crypto.randomUUID()}`;
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: orderId,
        status: 'CREATED',
        needsAttention: false
      });

      const paymentAId = `pay_${crypto.randomUUID()}`;
      const paymentA = {
        id: paymentAId,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };
      const paymentBId = `pay_${crypto.randomUUID()}`;
      const paymentB = {
        id: paymentBId,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const enrollA = vi
        .fn()
        .mockImplementation(async (tx, order, course) => enrollStudentInCourseTransaction(tx, order, course));
      const enrollB = vi
        .fn()
        .mockImplementation(async (tx, order, course) => enrollStudentInCourseTransaction(tx, order, course));

      await Promise.all([markPaidAndEnroll(paymentA, enrollA), markPaidAndEnroll(paymentB, enrollB)]);

      const [updatedOrder] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, orderId));
      expect(updatedOrder.status).toBe('PAID');
      expect(updatedOrder.razorpayPaymentId === paymentAId || updatedOrder.razorpayPaymentId === paymentBId).toBe(true);

      expect(updatedOrder.needsAttention).toBe(true);
      expect(updatedOrder.attentionReason).toBe('DUPLICATE_PAYMENT');

      const attentionIds = updatedOrder.attentionPaymentIds as string[];
      expect(attentionIds).toBeDefined();
      expect(attentionIds.length).toBe(1);
      const duplicateId = updatedOrder.razorpayPaymentId === paymentAId ? paymentBId : paymentAId;
      expect(attentionIds).toContain(duplicateId);

      const memberships = await db
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
      expect(memberships).toHaveLength(1);
    });

    it('real transaction rollback test', async () => {
      const orderId = `order_rollback_${crypto.randomUUID()}`;
      await db.insert(schema.courseOrder).values({
        organizationId: orgId,
        userId: userId,
        courseId: courseId,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: orderId,
        status: 'CREATED',
        needsAttention: false
      });

      const paymentId = `pay_rollback_${crypto.randomUUID()}`;
      const payment = {
        id: paymentId,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      const failingEnrollmentFunction = async (tx: any, order: any, course: any) => {
        // Create an organization member using the supplied tx
        await tx.insert(schema.organizationmember).values({
          organizationId: orgId,
          profileId: userId,
          role: 'member'
        });

        // Create a group member using the supplied tx
        await tx.insert(schema.groupmember).values({
          groupId: groupId,
          profileId: userId,
          role: 'member'
        });

        throw new Error('intentional rollback');
      };

      await expect(markPaidAndEnroll(payment, failingEnrollmentFunction)).rejects.toThrow(
        'Payment verified but enrollment failed. Please contact support.'
      );

      const [updatedOrder] = await db
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.razorpayOrderId, orderId));
      expect(updatedOrder.status).toBe('CREATED');
      expect(updatedOrder.razorpayPaymentId).toBeNull();
      expect(updatedOrder.needsAttention).toBe(true);
      expect(updatedOrder.attentionReason).toBe('ENROLLMENT_FAILED');

      const attentionIds = updatedOrder.attentionPaymentIds as string[];
      expect(attentionIds).toContain(paymentId);

      const memberships = await db
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
      expect(memberships).toHaveLength(0);

      const orgMemberships = await db
        .select()
        .from(schema.organizationmember)
        .where(
          and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
        );
      expect(orgMemberships).toHaveLength(0);
    });
  });
});
