import { db, type DbOrTxClient } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError, ErrorCodes } from '@cio/utils/errors';

export type VerifiedPayment = {
  id: string;
  razorpayOrderId: string;
  status: string;
  amountPaise: number;
  currency: string;
};

export type PaymentProcessResult = {
  handled: boolean;
  alreadyEnrolled: boolean;
  order: typeof schema.courseOrder.$inferSelect;
  effects?: any;
};

export class EnrollmentFailedError extends Error {
  constructor(
    message: string,
    public cause?: any
  ) {
    super(message);
    this.name = 'EnrollmentFailedError';
  }
}

export async function markPaidAndEnroll(
  payment: VerifiedPayment,
  enrollFn: (
    tx: DbOrTxClient,
    order: typeof schema.courseOrder.$inferSelect,
    course: typeof schema.course.$inferSelect
  ) => Promise<any>
): Promise<PaymentProcessResult> {
  const [preOrder] = await db
    .select({ id: schema.courseOrder.id, userId: schema.courseOrder.userId, courseId: schema.courseOrder.courseId })
    .from(schema.courseOrder)
    .where(eq(schema.courseOrder.razorpayOrderId, payment.razorpayOrderId))
    .limit(1);

  if (!preOrder) {
    throw new AppError('Order not found', ErrorCodes.NOT_FOUND, 404);
  }

  let transactionRolledBack = false;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`course_purchase:${preOrder.userId}:${preOrder.courseId}`}))`
      );

      const [order] = await tx
        .select()
        .from(schema.courseOrder)
        .where(eq(schema.courseOrder.id, preOrder.id))
        .for('update');

      if (!order) {
        throw new AppError('Order not found', ErrorCodes.NOT_FOUND, 404);
      }

      const [course] = await tx.select().from(schema.course).where(eq(schema.course.id, order.courseId)).limit(1);
      if (!course || !course.groupId) {
        throw new AppError('Course or group not found', ErrorCodes.VALIDATION_ERROR, 400);
      }

      if (payment.status !== 'captured') {
        if (order.razorpayPaymentId === payment.id && (order.status === 'PAID' || order.status === 'CREATED')) {
          return { handled: true, alreadyEnrolled: false, order };
        }
        throw new AppError('Payment is not captured', ErrorCodes.VALIDATION_ERROR, 400);
      }

      // Case A: Order is already PAID
      if (order.status === 'PAID') {
        if (order.razorpayPaymentId === payment.id) {
          return { handled: true, alreadyEnrolled: false, order };
        } else {
          const existingPaymentIds = (order.attentionPaymentIds as string[]) ?? [];
          const updatedPaymentIds = existingPaymentIds.includes(payment.id)
            ? existingPaymentIds
            : [...existingPaymentIds, payment.id];

          await tx
            .update(schema.courseOrder)
            .set({
              needsAttention: true,
              attentionReason: 'DUPLICATE_PAYMENT',
              attentionPaymentIds: updatedPaymentIds,
              updatedAt: new Date().toISOString()
            })
            .where(eq(schema.courseOrder.id, order.id));

          console.error(
            `[DUPLICATE_PAYMENT] Order ${order.id} was PAID with ${order.razorpayPaymentId}, but received ${payment.id}`
          );

          const [updatedOrder] = await tx.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, order.id));
          return { handled: true, alreadyEnrolled: false, order: updatedOrder };
        }
      }

      // Case B: Order is CREATED and razorpayPaymentId is already populated
      if (order.status === 'CREATED' && order.razorpayPaymentId) {
        if (order.razorpayPaymentId === payment.id) {
          return { handled: true, alreadyEnrolled: false, order };
        } else {
          const existingPaymentIds = (order.attentionPaymentIds as string[]) ?? [];
          const updatedPaymentIds = existingPaymentIds.includes(payment.id)
            ? existingPaymentIds
            : [...existingPaymentIds, payment.id];

          await tx
            .update(schema.courseOrder)
            .set({
              needsAttention: true,
              attentionReason: 'DUPLICATE_PAYMENT',
              attentionPaymentIds: updatedPaymentIds,
              updatedAt: new Date().toISOString()
            })
            .where(eq(schema.courseOrder.id, order.id));

          console.error(
            `[DUPLICATE_PAYMENT] Order ${order.id} already recorded payment ${order.razorpayPaymentId}; ignoring incoming payment ${payment.id}`
          );

          const [updatedOrder] = await tx.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, order.id));
          return { handled: true, alreadyEnrolled: false, order: updatedOrder };
        }
      }

      // Case F: SUPERSEDED / attention-locked CREATED order
      if (
        order.status === 'CREATED' &&
        order.needsAttention &&
        !order.razorpayPaymentId &&
        order.attentionReason !== 'ENROLLMENT_FAILED'
      ) {
        const existingPaymentIds = (order.attentionPaymentIds as string[]) ?? [];
        const updatedPaymentIds = existingPaymentIds.includes(payment.id)
          ? existingPaymentIds
          : [...existingPaymentIds, payment.id];

        await tx
          .update(schema.courseOrder)
          .set({
            needsAttention: true,
            attentionReason: order.attentionReason,
            razorpayPaymentId: payment.id,
            attentionPaymentIds: updatedPaymentIds,
            updatedAt: new Date().toISOString()
          })
          .where(eq(schema.courseOrder.id, order.id));

        console.error(
          `[SUPERSEDED_ORDER_PAYMENT] Payment ${payment.id} received for superseded order ${order.id}. Attention Reason: ${order.attentionReason}`
        );

        const [updatedOrder] = await tx.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, order.id));
        return { handled: true, alreadyEnrolled: false, order: updatedOrder };
      }

      // Case C/E: Normal CREATED order (or ENROLLMENT_FAILED retry)
      // Note: If order was ENROLLMENT_FAILED, needsAttention is true and razorpayPaymentId is null.
      // This falls through to here naturally because we excluded attentionReason !== 'ENROLLMENT_FAILED' in Case F.

      if (payment.amountPaise !== order.amountPaise || payment.currency !== order.currency) {
        const existingPaymentIds = (order.attentionPaymentIds as string[]) ?? [];
        const updatedPaymentIds = existingPaymentIds.includes(payment.id)
          ? existingPaymentIds
          : [...existingPaymentIds, payment.id];

        await tx
          .update(schema.courseOrder)
          .set({
            needsAttention: true,
            attentionReason: 'AMOUNT_MISMATCH',
            razorpayPaymentId: payment.id,
            attentionPaymentIds: updatedPaymentIds,
            updatedAt: new Date().toISOString()
          })
          .where(eq(schema.courseOrder.id, order.id));

        const [updatedOrder] = await tx.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, order.id));
        return { handled: true, alreadyEnrolled: false, order: updatedOrder };
      }

      // Case D/E: Reconcile and Enroll
      const [existingMembership] = await tx
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, course.groupId), eq(schema.groupmember.profileId, order.userId)))
        .limit(1);

      const isAlreadyEnrolled = !!existingMembership;

      let effects;
      try {
        effects = await enrollFn(tx, order, course);
      } catch (error) {
        transactionRolledBack = true;
        throw new EnrollmentFailedError('Enrollment failed', error);
      }

      await tx
        .update(schema.courseOrder)
        .set({
          status: 'PAID',
          razorpayPaymentId: payment.id,
          paidAt: new Date().toISOString(),
          needsAttention: isAlreadyEnrolled,
          attentionReason: isAlreadyEnrolled ? 'ALREADY_ENROLLED' : null,
          updatedAt: new Date().toISOString()
        })
        .where(eq(schema.courseOrder.id, order.id));

      const [updatedOrder] = await tx.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, order.id));
      return { handled: true, alreadyEnrolled: isAlreadyEnrolled, order: updatedOrder, effects };
    });
  } catch (error) {
    if (error instanceof EnrollmentFailedError && transactionRolledBack) {
      console.error(
        `[ENROLLMENT_FAILED] Local Order: ${preOrder.id}, User: ${preOrder.userId}, Course: ${preOrder.courseId}, Razorpay Order: ${payment.razorpayOrderId}, Payment ID: ${payment.id}.`
      );

      try {
        const result = await db
          .update(schema.courseOrder)
          .set({
            needsAttention: true,
            attentionReason: 'ENROLLMENT_FAILED',
            attentionPaymentIds: sql`CASE
  WHEN COALESCE(${schema.courseOrder.attentionPaymentIds}, '[]'::jsonb) @> to_jsonb(${payment.id}::text)
  THEN COALESCE(${schema.courseOrder.attentionPaymentIds}, '[]'::jsonb)
  ELSE COALESCE(${schema.courseOrder.attentionPaymentIds}, '[]'::jsonb) || to_jsonb(${payment.id}::text)
END`,
            updatedAt: new Date().toISOString()
          })
          .where(
            and(
              eq(schema.courseOrder.id, preOrder.id),
              eq(schema.courseOrder.status, 'CREATED'),
              isNull(schema.courseOrder.razorpayPaymentId)
            )
          )
          .returning({ id: schema.courseOrder.id });

        if (result.length === 0) {
          console.error(
            `[ENROLLMENT_FAILED] Order ${preOrder.id} changed state before failure marker could be persisted; refusing to overwrite current state.`
          );
        }
      } catch {
        console.error(`Failed to update ENROLLMENT_FAILED for order ${preOrder.id}`);
      }

      throw new AppError(
        'Payment verified but enrollment failed. Please contact support.',
        ErrorCodes.INTERNAL_ERROR,
        500
      );
    }

    throw error;
  }
}
