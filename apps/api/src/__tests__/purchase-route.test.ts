import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from '@api/utils/hono';
import { purchaseRouter } from '@api/routes/course/purchase';
import { createCoursePurchase } from '@cio/core/services/course/purchase';

vi.mock('@cio/core/services/course/purchase', () => ({
  createCoursePurchase: vi.fn()
}));

// Mock middlewares
vi.mock('@api/middlewares/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'user-1' });
    await next();
  }
}));

vi.mock('@api/middlewares/org-member', () => ({
  orgMemberMiddleware: async (c: any, next: any) => {
    // Mimic the behavior of orgMemberMiddleware setting orgId
    c.set('orgId', 'org-1');
    await next();
  }
}));

const app = new Hono().route('/course/:courseId/purchase', purchaseRouter);

describe('POST /course/:courseId/purchase', () => {
  const COURSE_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the organization context correctly and calls createCoursePurchase', async () => {
    vi.mocked(createCoursePurchase).mockResolvedValue({
      orderId: 'order-1',
      razorpayOrderId: 'rzp_order_1',
      amount: 50000,
      currency: 'INR'
    });

    const response = await app.request(`/course/${COURSE_ID}/purchase`, {
      method: 'POST'
    });

    expect(response.status).toBe(200);
    expect(createCoursePurchase).toHaveBeenCalledWith(COURSE_ID, 'user-1', 'org-1');

    expect(await response.json()).toEqual({
      success: true,
      data: {
        orderId: 'order-1',
        razorpayOrderId: 'rzp_order_1',
        amount: 50000,
        currency: 'INR'
      }
    });
  });
});
