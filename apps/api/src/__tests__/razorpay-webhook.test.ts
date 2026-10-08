import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from '@api/app';
import { env } from '@cio/core/config/env';
import { createHmac } from 'crypto';
import * as webhookClaim from '@cio/core/services/course/webhook-claim';
import * as razorpayService from '@cio/core/services/course/razorpay';

vi.mock('@cio/core/services/course/webhook-claim', () => ({
  claimRazorpayWebhookEvent: vi.fn(),
  resolveRazorpayWebhookEvent: vi.fn().mockResolvedValue({ status: 'resolved' })
}));

vi.mock('@cio/core/services/course/razorpay', () => ({
  verifyProviderPayment: vi.fn()
}));

vi.mock('@cio/core/config/env', () => ({
  env: {
    RAZORPAY_WEBHOOK_SECRET: 'test_secret'
  }
}));

describe('Razorpay Webhook Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function generateSignature(payload: string, secret: string = 'test_secret') {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  it('rejects missing signature', async () => {
    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: JSON.stringify({ event: 'order.paid' })
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing signature/);
  });

  it('rejects invalid signature', async () => {
    const payload = JSON.stringify({ event: 'order.paid' });
    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': 'invalidsignatureofsamellength1234567890123456789012345678901234',
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: payload
    });
    expect(res.status).toBe(401);
  });

  it('safely rejects signature length mismatch', async () => {
    const payload = JSON.stringify({ event: 'order.paid' });
    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': 'short',
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: payload
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing event ID', async () => {
    const payload = JSON.stringify({ event: 'order.paid' });
    const signature = generateSignature(payload);
    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature
      },
      body: payload
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing event ID/);
  });

  it('accepts valid signature and processes new event', async () => {
    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_123', order_id: 'order_123' } } }
    });
    const signature = generateSignature(payload);

    vi.mocked(webhookClaim.claimRazorpayWebhookEvent).mockResolvedValue({
      status: 'newly_claimed',
      eventId: 'evt_123',
      processingLeaseId: 'lease_123'
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: payload
    });

    expect(res.status).toBe(200);
    expect(webhookClaim.claimRazorpayWebhookEvent).toHaveBeenCalledWith(
      'evt_123',
      'order.paid',
      'order_123',
      'pay_123'
    );
  });

  it('handles unsupported events by marking them IGNORED', async () => {
    const payload = JSON.stringify({ event: 'unknown.event' });
    const signature = generateSignature(payload);

    vi.mocked(webhookClaim.claimRazorpayWebhookEvent).mockResolvedValue({
      status: 'newly_claimed',
      eventId: 'evt_123',
      processingLeaseId: 'lease_123'
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: payload
    });

    expect(res.status).toBe(200);
    expect(webhookClaim.resolveRazorpayWebhookEvent).toHaveBeenCalledWith(
      'evt_123',
      'IGNORED',
      'Unsupported event type',
      'lease_123'
    );
  });

  it('acknowledges duplicate_done idempotently', async () => {
    const payload = JSON.stringify({ event: 'order.paid' });
    const signature = generateSignature(payload);

    vi.mocked(webhookClaim.claimRazorpayWebhookEvent).mockResolvedValue({
      status: 'duplicate_done',
      eventId: 'evt_123'
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': 'evt_123'
      },
      body: payload
    });

    expect(res.status).toBe(200);
    expect(webhookClaim.resolveRazorpayWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 409 for in_progress claim without calling resolve or provider', async () => {
    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_456', order_id: 'order_456' } } }
    });
    const signature = generateSignature(payload);

    vi.mocked(webhookClaim.claimRazorpayWebhookEvent).mockResolvedValue({
      status: 'in_progress',
      eventId: 'evt_456'
    });

    const res = await app.request('/public-api/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': 'evt_456'
      },
      body: payload
    });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.message).toMatch(/retry/i);

    // Must NOT call resolve or provider verification
    expect(webhookClaim.resolveRazorpayWebhookEvent).not.toHaveBeenCalled();
  });
});
