import { Hono } from '@api/utils/hono';
import { handleError } from '@api/utils/errors';
import { authMiddleware } from '@api/middlewares/auth';
import { orgMemberMiddleware } from '@api/middlewares/org-member';
import { createCoursePurchase } from '@cio/core/services/course/purchase';

export const purchaseRouter = new Hono()
  /**
   * POST /course/:courseId/purchase
   * Creates a purchase order with Razorpay
   */
  .post('/', authMiddleware, orgMemberMiddleware, async (c) => {
    try {
      const courseId = c.req.param('courseId')!;
      const user = c.get('user')!;
      const organizationId = c.get('orgId')!;

      const result = await createCoursePurchase(courseId, user.id, organizationId);

      return c.json(
        {
          success: true,
          data: result
        },
        200
      );
    } catch (error) {
      return handleError(c, error, 'Failed to create course purchase order');
    }
  });
