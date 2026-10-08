import { Hono } from '@api/utils/hono';
import { bodyLimit } from 'hono/body-limit';
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

const RAZORPAY_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export const webhooksRouter = new Hono()
  .onError((err, c) => handleError(c, err))
  .post(
    '/razorpay',
    bodyLimit({
      maxSize: RAZORPAY_WEBHOOK_MAX_BODY_BYTES,
      onError: (c) => {
        return c.json({ success: false, message: 'Payload Too Large' }, 413);
      }
    }),
    async (c) => {
      const signature = c.req.header('X-Razorpay-Signature');
      const eventId = c.req.header('X-Razorpay-Event-Id');

      if (!signature || typeof signature !== 'string') {
        throw new AppError('Missing signature', ErrorCodes.VALIDATION_ERROR, 400);
      }
      if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
        throw new AppError('Invalid signature format', ErrorCodes.UNAUTHORIZED, 401);
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

      if (claim.status === 'duplicate_done') {
        return c.json({ success: true, message: 'Acknowledged' });
      }
      if (claim.status === 'in_progress') {
        // 409 Conflict forces Razorpay to retry later, avoiding silent loss if current worker dies.
        return c.json({ success: false, message: 'Processing in progress, please retry later' }, 409);
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
            const ignoreResult = await resolveRazorpayWebhookEvent(
              claim.eventId,
              'IGNORED',
              'No local course order found',
              claim.processingLeaseId
            );
            if (ignoreResult.status === 'lost_lease') {
              return c.json({ success: false, message: 'Webhook processing ownership was lost; retry required' }, 409);
            }
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

          const processedResult = await resolveRazorpayWebhookEvent(
            claim.eventId,
            'PROCESSED',
            'Payment fulfilled',
            claim.processingLeaseId
          );
          if (processedResult.status === 'lost_lease') {
            return c.json({ success: false, message: 'Webhook processing ownership was lost; retry required' }, 409);
          }
        } else {
          const ignoredResult = await resolveRazorpayWebhookEvent(
            claim.eventId,
            'IGNORED',
            'Unsupported event type',
            claim.processingLeaseId
          );
          if (ignoredResult.status === 'lost_lease') {
            return c.json({ success: false, message: 'Webhook processing ownership was lost; retry required' }, 409);
          }
        }

        return c.json({ success: true, message: 'Event received' });
      } catch (error) {
        let safeDetail = 'Webhook processing failed';
        if (error instanceof AppError) {
          if (error.statusCode === 502) safeDetail = 'Provider verification failed';
          else if (error.statusCode >= 400 && error.statusCode < 500) safeDetail = 'Validation failed';
          else safeDetail = 'Unexpected processing error';
        } else if (error instanceof Error && error.name === 'EnrollmentFailedError') {
          safeDetail = 'Enrollment failed';
        }

        await resolveRazorpayWebhookEvent(claim.eventId, 'FAILED', safeDetail, claim.processingLeaseId);
        throw error;
      }
    }
  );
