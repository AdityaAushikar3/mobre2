import { Hono } from '@api/utils/hono';
import { handleError, AppError, ErrorCodes } from '@api/utils/errors';
import { authMiddleware } from '@api/middlewares/auth';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { env } from '@cio/core/config/env';
import { markPaidAndEnroll } from '@cio/core/services/course/payment';
import { enrollStudentInCourseTransaction, runPostCommitSideEffects } from '../../services/course/payment';
import { verifyProviderPayment } from '@cio/core/services/course/razorpay';

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

    const verifiedPayment = await verifyProviderPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id
    });

    if (verifiedPayment.status === 'failed') {
      return c.json({ success: false, status: 'FAILED', message: 'Payment has failed' }, 400);
    }

    if (verifiedPayment.status !== 'captured') {
      return c.json({ success: true, status: 'PENDING', message: 'Payment is pending capture' });
    }

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
