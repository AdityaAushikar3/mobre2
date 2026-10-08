import Razorpay from 'razorpay';
import { AppError, ErrorCodes } from '@cio/utils/errors';
import { env } from '@cio/core/config/env';
import type { VerifiedPayment } from './payment';

function classifyRazorpayPaymentFetchError(err: any): AppError {
  if (err?.statusCode === 404) {
    return new AppError('Payment not found in provider', ErrorCodes.NOT_FOUND, 404);
  }
  if (
    err?.statusCode === 400 &&
    typeof err?.error?.description === 'string' &&
    /does not exist/i.test(err.error.description)
  ) {
    return new AppError('Payment not found in provider', ErrorCodes.NOT_FOUND, 404);
  }
  return new AppError('Failed to verify payment with provider', ErrorCodes.INTERNAL_ERROR, 502);
}

export async function verifyProviderPayment({
  razorpayOrderId,
  razorpayPaymentId
}: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}): Promise<VerifiedPayment> {
  if (!env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_KEY_ID) {
    throw new AppError('Razorpay is not configured', ErrorCodes.INTERNAL_ERROR, 500);
  }

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET
  });

  let payment;
  try {
    payment = await razorpay.payments.fetch(razorpayPaymentId);
  } catch (err: any) {
    throw classifyRazorpayPaymentFetchError(err);
  }

  if (payment.id !== razorpayPaymentId) {
    throw new AppError('Provider payment ID does not match requested payment ID', ErrorCodes.VALIDATION_ERROR, 400);
  }

  if (payment.order_id !== razorpayOrderId) {
    throw new AppError('Payment does not belong to the expected order', ErrorCodes.VALIDATION_ERROR, 400);
  }

  return {
    id: payment.id,
    razorpayOrderId: payment.order_id,
    status: payment.status,
    amountPaise: payment.amount as number,
    currency: payment.currency
  };
}
