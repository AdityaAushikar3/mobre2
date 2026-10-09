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
      const originalId = `pay_${crypto.randomUUID()}`;
      const duplicateId = `pay_${crypto.randomUUID()}`;
      await insertOrder({
        status: 'PAID',
        razorpayPaymentId: originalId,
        needsAttention: false
      });

      const incoming = makePayment({ id: duplicateId });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await markPaidAndEnroll(incoming, vi.fn());

        expect(result.handled).toBe(true);
        expect(result.order.razorpayPaymentId).toBe(originalId);
        expect(result.order.needsAttention).toBe(true);
        expect(result.order.attentionReason).toBe('DUPLICATE_PAYMENT');
        expect(result.order.attentionPaymentIds).toContain(duplicateId);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[DUPLICATE_PAYMENT]'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('CREATED + same existing payment is a locked idempotent no-op and never becomes PAID', async () => {
      const existingId = `pay_${crypto.randomUUID()}`;
      await insertOrder({
        razorpayPaymentId: existingId,
        status: 'CREATED'
      });

      const result = await markPaidAndEnroll(makePayment({ id: existingId }), vi.fn());

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.razorpayPaymentId).toBe(existingId);
    });

    it('CREATED + different existing payment preserves original and sets DUPLICATE_PAYMENT', async () => {
      const existingId = `pay_${crypto.randomUUID()}`;
      const differentId = `pay_${crypto.randomUUID()}`;
      await insertOrder({
        razorpayPaymentId: existingId,
        status: 'CREATED'
      });

      const incoming = makePayment({ id: differentId });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await markPaidAndEnroll(incoming, vi.fn());

        expect(result.handled).toBe(true);
        expect(result.order.status).toBe('CREATED');
        expect(result.order.razorpayPaymentId).toBe(existingId);
        expect(result.order.needsAttention).toBe(true);
        expect(result.order.attentionReason).toBe('DUPLICATE_PAYMENT');
        expect(result.order.attentionPaymentIds).toContain(differentId);
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

      const supersededId = `pay_${crypto.randomUUID()}`;
      const enrollFn = vi.fn();
      const payment = makePayment({ id: supersededId });
      const result = await markPaidAndEnroll(payment, enrollFn);

      expect(result.handled).toBe(true);
      expect(result.order.status).toBe('CREATED');
      expect(result.order.needsAttention).toBe(true);
      expect(result.order.attentionReason).toBe('AMOUNT_MISMATCH');
      expect(result.order.razorpayPaymentId).toBe(supersededId);
      expect(result.order.attentionPaymentIds).toContain(supersededId);
      expect(enrollFn).not.toHaveBeenCalled();
    });

    it('ENROLLMENT_FAILED is retryable and successful retry clears attention state', async () => {
      await insertOrder({
        needsAttention: true,
        attentionReason: 'ENROLLMENT_FAILED'
      });

      const failedId = `pay_${crypto.randomUUID()}`;
      const retryId = `pay_${crypto.randomUUID()}`;
      const failed = makePayment({ id: failedId });
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
        makePayment({ id: retryId }),
        vi.fn().mockResolvedValue({ retryEffect: true })
      );

      expect(retry.handled).toBe(true);
      expect(retry.order.status).toBe('PAID');
      expect(retry.order.razorpayPaymentId).toBe(retryId);
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
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
          roleId: ROLE.STUDENT
        });

        // Create a group member using the supplied tx
        await tx.insert(schema.groupmember).values({
          groupId: groupId,
          profileId: userId,
          roleId: ROLE.STUDENT
        });

        const orgMembers = await tx
          .select()
          .from(schema.organizationmember)
          .where(
            and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
          );
        expect(orgMembers).toHaveLength(1);

        const groupMembers = await tx
          .select()
          .from(schema.groupmember)
          .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
        expect(groupMembers).toHaveLength(1);

        throw new Error('intentional rollback');
      };

      await expect(markPaidAndEnroll(payment, failingEnrollmentFunction)).rejects.toThrow(
        'Payment verified but enrollment failed. Please contact support.'
      );

      const spyCalls = consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join(' ');
      expect(spyCalls).toContain('[ENROLLMENT_FAILED] Local Order:');
      consoleErrorSpy.mockRestore();

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
    it('failure traceability - sequential failures', async () => {
      const orderId = `order_seq_${crypto.randomUUID()}`;
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

      const failingFn = async () => {
        throw new Error('fail');
      };

      const paymentA = {
        id: `pay_${crypto.randomUUID()}`,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };
      const paymentB = {
        id: `pay_${crypto.randomUUID()}`,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      await expect(markPaidAndEnroll(paymentA as any, failingFn)).rejects.toThrow();
      await expect(markPaidAndEnroll(paymentB as any, failingFn)).rejects.toThrow();

      const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.razorpayOrderId, orderId));
      expect(order.status).toBe('CREATED');
      expect(order.razorpayPaymentId).toBeNull();
      expect(order.needsAttention).toBe(true);
      expect(order.attentionReason).toBe('ENROLLMENT_FAILED');
      expect(order.attentionPaymentIds as string[]).toContain(paymentA.id);
      expect(order.attentionPaymentIds as string[]).toContain(paymentB.id);
    });

    it('failure traceability - same ID repeated', async () => {
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

      const failingFn = async () => {
        throw new Error('fail');
      };
      const paymentId = `pay_${crypto.randomUUID()}`;
      const payment = {
        id: paymentId,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      await expect(markPaidAndEnroll(payment as any, failingFn)).rejects.toThrow();
      await expect(markPaidAndEnroll(payment as any, failingFn)).rejects.toThrow();

      const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.razorpayOrderId, orderId));
      const ids = order.attentionPaymentIds as string[];
      expect(ids.filter((id) => id === paymentId)).toHaveLength(1);
    });

    it('failure traceability - concurrent failures', async () => {
      const orderId = `order_conc_${crypto.randomUUID()}`;
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

      const failingFn = async () => {
        throw new Error('fail');
      };
      const paymentA = {
        id: `pay_${crypto.randomUUID()}`,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };
      const paymentB = {
        id: `pay_${crypto.randomUUID()}`,
        razorpayOrderId: orderId,
        status: 'captured',
        amountPaise: 50000,
        currency: 'INR'
      };

      await Promise.all([
        markPaidAndEnroll(paymentA as any, failingFn).catch(() => {}),
        markPaidAndEnroll(paymentB as any, failingFn).catch(() => {})
      ]);

      const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.razorpayOrderId, orderId));
      const ids = order.attentionPaymentIds as string[];
      expect(ids).toContain(paymentA.id);
      expect(ids).toContain(paymentB.id);
    });
    describe('non-captured payments never mutate order state', () => {
      async function getOrderSnapshot(orderId: string) {
        const [order] = await db
          .select()
          .from(schema.courseOrder)
          .where(eq(schema.courseOrder.razorpayOrderId, orderId));
        return {
          status: order.status,
          razorpayPaymentId: order.razorpayPaymentId,
          needsAttention: order.needsAttention,
          attentionReason: order.attentionReason,
          attentionPaymentIds: order.attentionPaymentIds,
          paidAt: order.paidAt,
          updatedAt: order.updatedAt
        };
      }

      async function getMembershipCounts() {
        const groupRes = await db
          .select()
          .from(schema.groupmember)
          .where(and(eq(schema.groupmember.groupId, groupId), eq(schema.groupmember.profileId, userId)));
        const orgRes = await db
          .select()
          .from(schema.organizationmember)
          .where(
            and(eq(schema.organizationmember.organizationId, orgId), eq(schema.organizationmember.profileId, userId))
          );
        return { groupCount: groupRes.length, orgCount: orgRes.length };
      }

      // a. CREATED order, razorpayPaymentId NULL, needsAttention false, matching amount and currency.
      it('rejects on CREATED order without mutations (status: authorized)', async () => {
        const orderId = `order_auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        await insertOrder({ razorpayOrderId: orderId });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payment = makePayment({
          id: `pay_${crypto.randomUUID()}`,
          razorpayOrderId: orderId,
          status: 'authorized'
        });

        await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow(/Payment is not captured/);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // a. Repeat with status: 'failed'
      it('rejects on CREATED order without mutations (status: failed)', async () => {
        const orderId = `order_fail_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        await insertOrder({ razorpayOrderId: orderId });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payment = makePayment({ id: `pay_${crypto.randomUUID()}`, razorpayOrderId: orderId, status: 'failed' });

        await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow(/Payment is not captured/);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // b. PAID order with razorpayPaymentId = payA, paidAt set. Incoming is payB, non-captured.
      it('rejects on PAID order with different payment without mutations', async () => {
        const orderId = `order_paid_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const payA = `pay_${crypto.randomUUID()}`;
        await insertOrder({
          razorpayOrderId: orderId,
          status: 'PAID',
          razorpayPaymentId: payA,
          paidAt: new Date().toISOString()
        });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payB = `pay_${crypto.randomUUID()}`;
        const payment = makePayment({ id: payB, razorpayOrderId: orderId, status: 'authorized' });

        await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow(/Payment is not captured/);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // c. CREATED order with recorded razorpayPaymentId = payA, needsAttention=true, attentionReason=AMOUNT_MISMATCH. Incoming payB, non-captured.
      it('rejects on CREATED order with different recorded payment and amount mismatch without mutations', async () => {
        const orderId = `order_amt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const payA = `pay_${crypto.randomUUID()}`;
        await insertOrder({
          razorpayOrderId: orderId,
          status: 'CREATED',
          razorpayPaymentId: payA,
          needsAttention: true,
          attentionReason: 'AMOUNT_MISMATCH'
        });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payB = `pay_${crypto.randomUUID()}`;
        const payment = makePayment({ id: payB, razorpayOrderId: orderId, status: 'authorized' });

        await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow(/Payment is not captured/);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // d. Superseded order: CREATED, needsAttention=true, attentionReason=AMOUNT_MISMATCH, razorpayPaymentId NULL, attentionPaymentIds empty. Incoming non-captured.
      it('rejects on superseded order without mutations', async () => {
        const orderId = `order_sup_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        await insertOrder({
          razorpayOrderId: orderId,
          status: 'CREATED',
          razorpayPaymentId: null,
          needsAttention: true,
          attentionReason: 'AMOUNT_MISMATCH',
          attentionPaymentIds: []
        });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payment = makePayment({
          id: `pay_${crypto.randomUUID()}`,
          razorpayOrderId: orderId,
          status: 'authorized'
        });

        await expect(markPaidAndEnroll(payment, enrollFn)).rejects.toThrow(/Payment is not captured/);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // e1. PAID order with razorpayPaymentId = payA. Incoming non-captured payA.
      it('resolves as no-op on PAID order with matching payment', async () => {
        const orderId = `order_pe1_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const payA = `pay_${crypto.randomUUID()}`;
        await insertOrder({
          razorpayOrderId: orderId,
          status: 'PAID',
          razorpayPaymentId: payA,
          paidAt: new Date().toISOString()
        });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payment = makePayment({ id: payA, razorpayOrderId: orderId, status: 'authorized' });

        const result = await markPaidAndEnroll(payment, enrollFn);
        expect(result.handled).toBe(true);
        expect(result.alreadyEnrolled).toBe(false);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });

      // e2. CREATED order with recorded razorpayPaymentId = payA. Incoming non-captured payA.
      it('resolves as no-op on CREATED order with matching payment', async () => {
        const orderId = `order_ce2_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const payA = `pay_${crypto.randomUUID()}`;
        await insertOrder({ razorpayOrderId: orderId, status: 'CREATED', razorpayPaymentId: payA });
        const snapshot = await getOrderSnapshot(orderId);
        const memberships = await getMembershipCounts();
        const enrollFn = vi.fn();

        const payment = makePayment({ id: payA, razorpayOrderId: orderId, status: 'authorized' });

        const result = await markPaidAndEnroll(payment, enrollFn);
        expect(result.handled).toBe(true);
        expect(result.alreadyEnrolled).toBe(false);

        expect(await getOrderSnapshot(orderId)).toEqual(snapshot);
        expect(enrollFn).not.toHaveBeenCalled();
        expect(await getMembershipCounts()).toEqual(memberships);
      });
    });
  });
});
