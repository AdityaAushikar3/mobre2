import { Hono } from '@api/utils/hono';
import { handleError, AppError, ErrorCodes } from '@api/utils/errors';
import { authMiddleware } from '@api/middlewares/auth';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { env } from '@cio/core/config/env';
import Razorpay from 'razorpay';
import { markPaidAndEnroll, type VerifiedPayment } from '@cio/core/services/course/payment';
import { enrollStudentInCourseTransaction, runPostCommitSideEffects } from '../../services/course/payment';

export const verifyRouter = new Hono().post('/orders/:orderId/verify', authMiddleware, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const user = c.get('user')!;

    let body;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('Invalid JSON body', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError('Request body must be a JSON object', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    if (!razorpay_order_id || typeof razorpay_order_id !== 'string') {
      throw new AppError('Invalid or missing razorpay_order_id', ErrorCodes.VALIDATION_ERROR, 400);
    }
    if (!razorpay_payment_id || typeof razorpay_payment_id !== 'string') {
      throw new AppError('Invalid or missing razorpay_payment_id', ErrorCodes.VALIDATION_ERROR, 400);
    }
    if (
      !razorpay_signature ||
      typeof razorpay_signature !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(razorpay_signature)
    ) {
      throw new AppError('Invalid or missing razorpay_signature', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const [order] = await db.select().from(schema.courseOrder).where(eq(schema.courseOrder.id, orderId)).limit(1);

    if (!order) {
      throw new AppError('Order not found', ErrorCodes.NOT_FOUND, 404);
    }

    if (order.userId !== user.id) {
      throw new AppError('Unauthorized order access', ErrorCodes.UNAUTHORIZED, 403);
    }

    if (order.razorpayOrderId !== razorpay_order_id) {
      throw new AppError('Order mismatch', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (!env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_KEY_ID) {
      throw new AppError('Razorpay is not configured', ErrorCodes.INTERNAL_ERROR, 500);
    }

    const generatedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const expectedBuffer = Buffer.from(generatedSignature);
    const actualBuffer = Buffer.from(razorpay_signature);

    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new AppError('Invalid payment signature', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET
    });

    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.error?.code === 'BAD_REQUEST_ERROR') {
        throw new AppError('Payment not found in provider', ErrorCodes.NOT_FOUND, 404);
      }
      throw new AppError('Failed to verify payment with provider', ErrorCodes.INTERNAL_ERROR, 502);
    }

    if (payment.id !== razorpay_payment_id) {
      throw new AppError('Provider payment ID does not match requested payment ID', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (payment.order_id !== razorpay_order_id) {
      throw new AppError('Payment does not belong to the expected order', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (payment.status === 'failed') {
      return c.json({ success: false, status: 'FAILED', message: 'Payment has failed' }, 400);
    }

    if (payment.status !== 'captured') {
      return c.json({ success: true, status: 'PENDING', message: 'Payment is pending capture' });
    }

    const verifiedPayment: VerifiedPayment = {
      id: payment.id,
      razorpayOrderId: payment.order_id,
      status: payment.status,
      amountPaise: payment.amount as number,
      currency: payment.currency
    };

    const result = await markPaidAndEnroll(verifiedPayment, enrollStudentInCourseTransaction);

    if (result.effects) {
      try {
        await runPostCommitSideEffects(result.effects);
      } catch (err) {
        console.error('Fatal error in side effects (should be caught internally):', err);
      }
    }

    return c.json(
      {
        success: true,
        data: result.order,
        alreadyEnrolled: result.alreadyEnrolled
      },
      200
    );
  } catch (error) {
    return handleError(c, error, 'Failed to verify course payment');
  }
});
