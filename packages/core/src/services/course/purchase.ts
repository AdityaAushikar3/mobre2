import { AppError, ErrorCodes } from '@cio/utils/errors';
import { db, type DbOrTxClient } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { and, eq, sql, isNull } from 'drizzle-orm';
import { getCourseById } from '@cio/db/queries/course';
import { env } from '../../config/env';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const MIN_AMOUNT_PAISE = 100;
const MAX_AMOUNT_PAISE = 2147483647; // PostgreSQL integer upper bound

function getRazorpayClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError('Razorpay is not configured on this server', ErrorCodes.INTERNAL_ERROR, 500);
  }
  return new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET
  });
}

export async function createCoursePurchase(courseId: string, userId: string, organizationId: string) {
  return await db.transaction(async (tx) => {
    // Acquire transaction-scoped advisory lock for this user + course
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course_purchase:${userId}:${courseId}`}))`);

    const [course] = await getCourseById(courseId, tx);
    if (!course) {
      throw new AppError('Course not found', ErrorCodes.COURSE_NOT_FOUND, 404);
    }

    // Validate organization boundary via the group
    if (!course.groupId) {
      throw new AppError(
        'Course is not properly configured for purchases (missing group)',
        ErrorCodes.VALIDATION_ERROR,
        400
      );
    }
    const [group] = await tx.select().from(schema.group).where(eq(schema.group.id, course.groupId)).limit(1);
    if (!group || group.organizationId !== organizationId) {
      throw new AppError('Course not found in this organization', ErrorCodes.COURSE_NOT_FOUND, 404);
    }

    if (course.currency !== 'INR') {
      throw new AppError('Only INR is supported for purchases', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const cost = course.cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost)) {
      throw new AppError('Invalid course price', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const amountPaise = cost * 100;

    if (!Number.isSafeInteger(amountPaise)) {
      throw new AppError('Course price is not a safe integer in paise', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (amountPaise < MIN_AMOUNT_PAISE) {
      throw new AppError('Course cost is below the minimum allowed for purchase', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (amountPaise > MAX_AMOUNT_PAISE) {
      throw new AppError('Course price exceeds maximum allowed value', ErrorCodes.VALIDATION_ERROR, 400);
    }

    // Ensure it's an exact integer, do not silently round
    if (amountPaise % 1 !== 0) {
      throw new AppError('Course price is not a valid discrete amount in paise', ErrorCodes.VALIDATION_ERROR, 400);
    }

    // Unresolved ENROLLMENT_FAILED check
    const [failedOrder] = await tx
      .select()
      .from(schema.courseOrder)
      .where(
        and(
          eq(schema.courseOrder.userId, userId),
          eq(schema.courseOrder.courseId, courseId),
          eq(schema.courseOrder.status, 'CREATED'),
          eq(schema.courseOrder.attentionReason, 'ENROLLMENT_FAILED')
        )
      )
      .limit(1);

    if (failedOrder) {
      throw new AppError(
        'Your payment is being processed. Please contact support if this takes long.',
        ErrorCodes.CONFLICT,
        400
      );
    }

    // Already enrolled check via group membership
    if (course.groupId) {
      const [membership] = await tx
        .select()
        .from(schema.groupmember)
        .where(and(eq(schema.groupmember.groupId, course.groupId), eq(schema.groupmember.profileId, userId)))
        .limit(1);

      if (membership) {
        throw new AppError('You are already enrolled in this course', ErrorCodes.CONFLICT, 400);
      }
    }

    // Look for an existing CREATED order within 30 minutes that is fully reusable
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const [existingOrder] = await tx
      .select()
      .from(schema.courseOrder)
      .where(
        and(
          eq(schema.courseOrder.userId, userId),
          eq(schema.courseOrder.courseId, courseId),
          eq(schema.courseOrder.status, 'CREATED'),
          isNull(schema.courseOrder.razorpayPaymentId),
          eq(schema.courseOrder.needsAttention, false),
          sql`${schema.courseOrder.createdAt} >= ${thirtyMinsAgo}`
        )
      )
      .orderBy(sql`${schema.courseOrder.createdAt} DESC`)
      .limit(1);

    if (existingOrder && existingOrder.amountPaise === amountPaise) {
      return {
        orderId: existingOrder.id,
        razorpayOrderId: existingOrder.razorpayOrderId,
        amount: existingOrder.amountPaise,
        currency: existingOrder.currency
      };
    }

    // We need to create a new order
    const razorpay = getRazorpayClient();
    const receiptId = crypto.randomUUID().slice(0, 36);

    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: receiptId,
      notes: {
        userId,
        courseId
      }
    });

    if (!rzpOrder || !rzpOrder.id) {
      throw new AppError('Failed to create payment order with provider', ErrorCodes.INTERNAL_ERROR, 500);
    }

    const [newOrder] = await tx
      .insert(schema.courseOrder)
      .values({
        organizationId,
        userId,
        courseId,
        amountPaise,
        currency: 'INR',
        razorpayOrderId: rzpOrder.id,
        status: 'CREATED',
        needsAttention: false,
        razorpayPaymentId: null,
        attentionReason: null
      })
      .returning();

    return {
      orderId: newOrder.id,
      razorpayOrderId: newOrder.razorpayOrderId,
      amount: newOrder.amountPaise,
      currency: newOrder.currency
    };
  });
}
