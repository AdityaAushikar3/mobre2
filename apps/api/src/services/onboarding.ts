import { AppError, ErrorCodes } from '@api/utils/errors';
import type { TProfile } from '@cio/db/types';
import {
  checkSiteNameExists,
  createOrganization,
  createOrganizationMember,
  createOrganizationPlan,
  getOrganizationByProfileId,
  getOrganizationCount
} from '@cio/db/queries';
import { markWelcomeEmailPending, updateProfile, getProfileById } from '@cio/db/queries/auth';

import { env } from '@cio/core/config/env';
import { ROLE } from '@cio/utils/constants';
import { PLAN } from '@cio/utils/plans';
import { db } from '@cio/db/drizzle';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@cio/db/schema';

export async function createOrganizationWithOwner(
  profileId: string,
  input: {
    fullname?: string;
    orgName: string;
    siteName: string;
  }
) {
  // Self-hosted: enforce admin email matching before allowing org creation
  if (env.PUBLIC_IS_SELFHOSTED === 'true') {
    if (!env.LMS_ADMIN_EMAIL) {
      throw new AppError(
        'Platform administrator email is not configured (LMS_ADMIN_EMAIL)',
        ErrorCodes.VALIDATION_ERROR,
        403
      );
    }
    const authUsers = await db.select().from(schema.user).where(eq(schema.user.id, profileId)).limit(1);
    const authUser = authUsers[0];
    if (
      !authUser ||
      !authUser.emailVerified ||
      authUser.email?.toLowerCase().trim() !== env.LMS_ADMIN_EMAIL.toLowerCase().trim()
    ) {
      throw new AppError(
        'Only the verified designated administrator can create the platform organization',
        ErrorCodes.VALIDATION_ERROR,
        403
      );
    }
  }

  // Business Logic: Check sitename availability
  const exists = await checkSiteNameExists(input.siteName);
  if (exists) {
    console.error('Site name already exists:', input.siteName);
    throw new AppError(`Site name '${input.siteName}' already exists`, ErrorCodes.SITENAME_EXISTS, 409);
  }

  // Business Logic: Create org and member in a transaction
  try {
    const result = await db.transaction(async (tx) => {
      // Self-hosted: block org creation when an org already exists (with row exclusive lock)
      if (env.PUBLIC_IS_SELFHOSTED === 'true') {
        await tx.execute(sql`LOCK TABLE "organization" IN SHARE ROW EXCLUSIVE MODE`);
        const count = await getOrganizationCount(tx);
        if (count > 0) {
          throw new AppError('Self-hosted instances support only one organization', ErrorCodes.VALIDATION_ERROR, 403);
        }
      }

      const organization = await createOrganization(
        {
          name: input.orgName,
          siteName: input.siteName
        },
        tx
      );

      const member = await createOrganizationMember(
        {
          organizationId: organization.id,
          profileId,
          roleId: ROLE.ADMIN,
          verified: true
        },
        tx
      );

      // Self-hosted: assign Enterprise plan to the new org
      if (env.PUBLIC_IS_SELFHOSTED === 'true') {
        await createOrganizationPlan(
          {
            orgId: organization.id,
            planName: PLAN.ENTERPRISE as 'ENTERPRISE',
            subscriptionId: `selfhosted-${organization.id}`,
            triggeredBy: member.id,
            payload: {},
            isActive: true,
            provider: 'selfhosted'
          },
          tx
        );
      }

      const organizations = await getOrganizationByProfileId(profileId, tx);

      return { organization, member, organizations };
    });

    return {
      organization: result.organization,
      member: result.member,
      organizations: result.organizations
    };
  } catch (error) {
    console.error('Error creating organization:', error);
    // Handle database constraint violations
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new AppError(`Site name '${input.siteName}' already exists`, ErrorCodes.SITENAME_EXISTS, 409);
    }
    throw new AppError(error instanceof Error ? error : new Error('Unknown error'), ErrorCodes.ORG_CREATE_FAILED, 500);
  }
}

export async function updateUserOnboarding(userId: string, data: Partial<TProfile>) {
  try {
    const updatedProfile = await updateProfile(userId, data);

    if (!updatedProfile) {
      throw new AppError('Failed to update profile - profile not found', ErrorCodes.PROFILE_NOT_FOUND, 404);
    }

    return updatedProfile;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      error instanceof Error ? error : new Error('Unknown error'),
      ErrorCodes.PROFILE_UPDATE_FAILED,
      500
    );
  }
}

export async function markOnboardingWelcomeEmailPending(userId: string) {
  const organizations = await getOrganizationByProfileId(userId);
  if (organizations.length > 0) {
    throw new AppError(
      'Welcome email onboarding is only available for new dashboard accounts',
      ErrorCodes.VALIDATION_ERROR,
      403
    );
  }

  const updatedProfile = await markWelcomeEmailPending(userId);
  if (!updatedProfile) {
    throw new AppError('Profile not found', ErrorCodes.PROFILE_NOT_FOUND, 404);
  }
}
