import { describe, expect, it, vi } from 'vitest';
import { createProfileHook } from '@cio/db/auth/hooks/create-profile';
import { ensureSelfHostedStudentMembership } from '@cio/db/queries/organization';
import { env } from '@cio/core/config/env';

// Mock dependencies
vi.mock('@cio/db/queries/organization', () => ({
  ensureSelfHostedStudentMembership: vi.fn(),
  getOrganizationCount: vi.fn().mockResolvedValue(1)
}));

vi.mock('@cio/db/auth/hooks/sso-provisioning', () => ({
  ssoProvisioningHook: vi.fn()
}));

vi.mock('@cio/db/drizzle', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([])
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue({})
    }))
  }
}));

describe('Phase 1 - Student Auto-Provisioning', () => {
  it('calls ensureSelfHostedStudentMembership when LMS_OPEN_SIGNUP is enabled', async () => {
    process.env.PUBLIC_IS_SELFHOSTED = 'true';
    process.env.LMS_OPEN_SIGNUP = 'true';

    const mockUser = {
      id: 'student-1',
      email: 'student@example.com',
      emailVerified: true
    };

    await createProfileHook(mockUser as any);

    expect(ensureSelfHostedStudentMembership).toHaveBeenCalledWith({
      profileId: 'student-1',
      email: 'student@example.com'
    });
  });

  it('does NOT call ensureSelfHostedStudentMembership when LMS_OPEN_SIGNUP is false', async () => {
    process.env.PUBLIC_IS_SELFHOSTED = 'true';
    process.env.LMS_OPEN_SIGNUP = 'false';
    vi.clearAllMocks();

    const mockUser = {
      id: 'student-2',
      email: 'student2@example.com',
      emailVerified: true
    };

    await createProfileHook(mockUser as any);

    expect(ensureSelfHostedStudentMembership).not.toHaveBeenCalled();
  });
});
