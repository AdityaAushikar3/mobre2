import { Hono } from '@api/utils/hono';
import { env } from '@cio/core/config/env';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppError, ErrorCodes } from '@api/utils/errors';
import { claimRazorpayWebhookEvent, resolveRazorpayWebhookEvent } from '@cio/core/services/course/webhook-claim';
import { db } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import { eq } from 'drizzle-orm';
import { verifyProviderPayment } from '@cio/core/services/course/razorpay';
import { markPaidAndEnroll } from '@cio/core/services/course/payment';
import { enrollStudentInCourseTransaction, runPostCommitSideEffects } from '../services/course/payment';
import { handleError } from '@api/utils/errors';

export const webhooksRouter = new Hono()
  .onError((err, c) => handleError(c, err))
  .post('/razorpay', async (c) => {
    const signature = c.req.header('X-Razorpay-Signature');
    const eventId = c.req.header('X-Razorpay-Event-Id');

    if (!signature || typeof signature !== 'string') {
      throw new AppError('Missing signature', ErrorCodes.VALIDATION_ERROR, 400);
    }
    if (!eventId || typeof eventId !== 'string') {
      throw new AppError('Missing event ID', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const rawBody = await c.req.text();

    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      throw new AppError('Webhook secret not configured', ErrorCodes.INTERNAL_ERROR, 500);
    }

    const expectedSignature = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) {
      throw new AppError('Invalid signature length', ErrorCodes.UNAUTHORIZED, 401);
    }
    if (!timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new AppError('Invalid signature', ErrorCodes.UNAUTHORIZED, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      throw new AppError('Invalid JSON', ErrorCodes.VALIDATION_ERROR, 400);
    }

    if (!payload || typeof payload !== 'object') {
      throw new AppError('Malformed payload', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const event = payload as {
      event?: string;
      payload?: { payment?: { entity?: { id: string; order_id?: string } }; order?: { entity?: { id: string } } };
    };
    const eventType = event.event;

    if (!eventType || typeof eventType !== 'string') {
      throw new AppError('Missing event type', ErrorCodes.VALIDATION_ERROR, 400);
    }

    let razorpayOrderId: string | undefined;
    let razorpayPaymentId: string | undefined;

    if (eventType === 'order.paid') {
      razorpayOrderId = event.payload?.order?.entity?.id || event.payload?.payment?.entity?.order_id;
      razorpayPaymentId = event.payload?.payment?.entity?.id;
    }

    const claim = await claimRazorpayWebhookEvent(eventId, eventType, razorpayOrderId, razorpayPaymentId);

    if (claim.status === 'duplicate_done' || claim.status === 'in_progress') {
      return c.json({ success: true, message: 'Acknowledged' });
    }

    // newly_claimed
    try {
      if (eventType === 'order.paid') {
        if (!razorpayOrderId || typeof razorpayOrderId !== 'string') {
          throw new AppError('Missing razorpayOrderId', ErrorCodes.VALIDATION_ERROR, 400);
        }
        if (!razorpayPaymentId || typeof razorpayPaymentId !== 'string') {
          throw new AppError('Missing razorpayPaymentId', ErrorCodes.VALIDATION_ERROR, 400);
        }

        const [order] = await db
          .select()
          .from(schema.courseOrder)
          .where(eq(schema.courseOrder.razorpayOrderId, razorpayOrderId))
          .limit(1);

        if (!order) {
          await resolveRazorpayWebhookEvent(claim.eventId, 'IGNORED', 'No local course order found');
          return c.json({ success: true, message: 'Acknowledged: Order not found locally' });
        }

        const verifiedPayment = await verifyProviderPayment({
          razorpayOrderId,
          razorpayPaymentId
        });

        if (verifiedPayment.status !== 'captured') {
          throw new AppError('Payment is not captured', ErrorCodes.VALIDATION_ERROR, 400);
        }

        const result = await markPaidAndEnroll(verifiedPayment, enrollStudentInCourseTransaction);

        if (result.effects) {
          try {
            await runPostCommitSideEffects(result.effects);
          } catch (err) {
            console.error('Fatal error in side effects (should be caught internally):', err);
          }
        }

        await resolveRazorpayWebhookEvent(claim.eventId, 'PROCESSED', 'Payment fulfilled');
      } else {
        await resolveRazorpayWebhookEvent(claim.eventId, 'IGNORED', 'Unsupported event type');
      }

      return c.json({ success: true, message: 'Event received' });
    } catch (error) {
      await resolveRazorpayWebhookEvent(
        claim.eventId,
        'FAILED',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  });
