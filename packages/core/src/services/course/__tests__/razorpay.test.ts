import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyProviderPayment } from '../razorpay';
import Razorpay from 'razorpay';
import { ErrorCodes } from '@cio/utils/errors';

vi.mock('razorpay', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      payments: {
        fetch: vi.fn()
      }
    }))
  };
});

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_KEY_ID: 'test_key',
    RAZORPAY_KEY_SECRET: 'test_secret'
  }
}));

describe('verifyProviderPayment', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Razorpay).mockImplementation(
      () =>
        ({
          payments: { fetch: mockFetch }
        }) as any
    );
  });

  it('1. successful captured payment → correct VerifiedPayment', async () => {
    mockFetch.mockResolvedValue({
      id: 'pay_123',
      order_id: 'order_123',
      status: 'captured',
      amount: 50000,
      currency: 'INR'
    });

    const result = await verifyProviderPayment({
      razorpayOrderId: 'order_123',
      razorpayPaymentId: 'pay_123'
    });

    expect(result).toEqual({
      id: 'pay_123',
      razorpayOrderId: 'order_123',
      status: 'captured',
      amountPaise: 50000,
      currency: 'INR'
    });
  });

  it('2. payment ID mismatch', async () => {
    mockFetch.mockResolvedValue({
      id: 'pay_other',
      order_id: 'order_123',
      status: 'captured',
      amount: 50000,
      currency: 'INR'
    });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Provider payment ID does not match requested payment ID',
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400
    });
  });

  it('3. provider order ID mismatch', async () => {
    mockFetch.mockResolvedValue({
      id: 'pay_123',
      order_id: 'order_other',
      status: 'captured',
      amount: 50000,
      currency: 'INR'
    });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Payment does not belong to the expected order',
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400
    });
  });

  it('4. actual statusCode 404', async () => {
    mockFetch.mockRejectedValue({ statusCode: 404 });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Payment not found in provider',
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404
    });
  });

  it('5. statusCode 400 + "payment does not exist"', async () => {
    mockFetch.mockRejectedValue({
      statusCode: 400,
      error: { description: 'The payment does not exist' }
    });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Payment not found in provider',
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404
    });
  });

  it('6. statusCode 400 + "payment already exists" → 502', async () => {
    mockFetch.mockRejectedValue({
      statusCode: 400,
      error: { description: 'The payment already exists' }
    });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });

  it('7. statusCode 401 + BAD_REQUEST_ERROR + "payment does not exist" → 502', async () => {
    mockFetch.mockRejectedValue({
      statusCode: 401,
      error: { code: 'BAD_REQUEST_ERROR', description: 'The payment does not exist' }
    });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });

  it('8. statusCode 401 → 502', async () => {
    mockFetch.mockRejectedValue({ statusCode: 401 });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });

  it('9. statusCode 500 → 502', async () => {
    mockFetch.mockRejectedValue({ statusCode: 500 });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });

  it('10. Error("ECONNRESET") → 502', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });

  it('11. timeout/network-style error → 502', async () => {
    mockFetch.mockRejectedValue({ code: 'ETIMEDOUT' });

    await expect(
      verifyProviderPayment({
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123'
      })
    ).rejects.toMatchObject({
      message: 'Failed to verify payment with provider',
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 502
    });
  });
});
