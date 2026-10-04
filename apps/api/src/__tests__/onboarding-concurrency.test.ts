import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { db } from '@cio/db/drizzle';
import { sql } from 'drizzle-orm';
import * as schema from '@db/schema';
import { createOrganizationWithOwner } from '@api/services/onboarding';
import { env } from '@cio/core/config/env';
import { ensureSelfHostedStudentMembership } from '@cio/db/queries/organization';
import { ROLE } from '@cio/utils/constants';

describe('Phase 1 - Onboarding and JIT Provisioning', () => {
  beforeAll(() => {
    env.PUBLIC_IS_SELFHOSTED = 'true';
    env.LMS_ADMIN_EMAIL = 'admin@example.com';
    env.LMS_OPEN_SIGNUP = 'true';
  });

  afterAll(() => {
    env.PUBLIC_IS_SELFHOSTED = 'false';
    env.LMS_OPEN_SIGNUP = 'false';
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ${schema.organizationmember} CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ${schema.organization} CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ${schema.profile} CASCADE`);
    await db.execute(sql`TRUNCATE TABLE ${schema.user} CASCADE`);

    // Create the admin user & profile
    await db.insert(schema.user).values({
      id: '00000000-0000-4000-a000-000000000001',
      email: 'admin@example.com',
      name: 'Admin User',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await db.insert(schema.profile).values({
      id: '00000000-0000-4000-a000-000000000001',
      email: 'admin@example.com',
      fullname: 'Admin User',
      username: 'admin'
    });

    // Create a normal user & profile
    await db.insert(schema.user).values({
      id: '00000000-0000-4000-a000-000000000002',
      email: 'student@example.com',
      name: 'Student User',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await db.insert(schema.profile).values({
      id: '00000000-0000-4000-a000-000000000002',
      email: 'student@example.com',
      fullname: 'Student User',
      username: 'student'
    });

    // Create a hacker user & profile (unverified admin email)
    await db.insert(schema.user).values({
      id: '00000000-0000-4000-a000-000000000003',
      email: 'hacker@example.com',
      name: 'Hacker User',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await db.insert(schema.profile).values({
      id: '00000000-0000-4000-a000-000000000003',
      email: 'future_admin@example.com', // Mutated profile email
      fullname: 'Hacker User',
      username: 'hacker'
    });
  });

  describe('ISSUE 1 - LMS_ADMIN_EMAIL trust boundaries', () => {
    it('normal user -> attempts to use configured admin email in profile -> cannot bootstrap', async () => {
      const originalAdmin = env.LMS_ADMIN_EMAIL;
      env.LMS_ADMIN_EMAIL = 'future_admin@example.com';
      try {
        const attempt = createOrganizationWithOwner('00000000-0000-4000-a000-000000000003', {
          orgName: 'Hacker Org',
          siteName: 'hacker-org'
        });
        await expect(attempt).rejects.toThrow(
          'Only the verified designated administrator can create the platform organization'
        );
      } finally {
        env.LMS_ADMIN_EMAIL = originalAdmin;
      }
    });

    it('trusted configured administrator -> can bootstrap', async () => {
      const result = await createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
        orgName: 'Admin Org',
        siteName: 'admin-org'
      });
      expect(result.organization).toBeDefined();
      expect(result.member.roleId).toBe(ROLE.ADMIN);
    });
  });

  describe('Singleton Organization Bootstrap Concurrency', () => {
    it('safely handles concurrent organization creation under PostgreSQL row locks', async () => {
      const attempts = [
        createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
          orgName: 'Race 1',
          siteName: 'race-1'
        }),
        createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
          orgName: 'Race 2',
          siteName: 'race-2'
        })
      ];

      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      if (rejected[0].status === 'rejected') {
        expect(rejected[0].reason.message).toContain('support only one organization');
      }

      const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.organization);
      expect(Number(countResult[0].count)).toBe(1);
    });
  });

  describe('ISSUE 2 - JIT student provisioning', () => {
    it('1. Admin before organization: JIT fallback does NOT create STUDENT membership', async () => {
      const provisioned = await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000001',
        email: 'admin@example.com'
      });

      expect(provisioned).toBe(false);
      const members = await db.select().from(schema.organizationmember);
      expect(members.length).toBe(0);
    });

    it('2. Student before organization: organization is then created -> later JIT provisioning succeeds', async () => {
      // Student tries before org
      const provisionedEarly = await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000002',
        email: 'student@example.com'
      });
      expect(provisionedEarly).toBe(false);

      // Admin creates org
      await createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
        orgName: 'Main Org',
        siteName: 'main-org'
      });

      // Later JIT provisioning for student succeeds
      const provisionedLate = await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000002',
        email: 'student@example.com'
      });
      expect(provisionedLate).toBe(true);

      const members = await db.select().from(schema.organizationmember);
      expect(members.length).toBe(2); // 1 admin, 1 student
      const studentMember = members.find((m) => m.profileId === '00000000-0000-4000-a000-000000000002');
      expect(studentMember?.roleId).toBe(ROLE.STUDENT);
    });

    it('3. Repeated student JIT: repeated requests do not create duplicate membership', async () => {
      await createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
        orgName: 'Main Org',
        siteName: 'main-org'
      });

      const attempt1 = await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000002',
        email: 'student@example.com'
      });
      expect(attempt1).toBe(true);

      const attempt2 = await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000002',
        email: 'student@example.com'
      });
      expect(attempt2).toBe(true); // Implementation returns true even if they exist (graceful)

      const members = await db.select().from(schema.organizationmember);
      expect(members.length).toBe(2); // Should not have duplicated the student
    });

    it('4. Admin after organization: administrator bootstrap succeeds normally, JIT does not degrade them', async () => {
      await createOrganizationWithOwner('00000000-0000-4000-a000-000000000001', {
        orgName: 'Main Org',
        siteName: 'main-org'
      });

      // Admin has ADMIN role. If ensureSelfHostedStudentMembership is called for them somehow:
      // (Even though our guards in hooks.server.ts/create-profile.ts prevent it, the DB query should also be robust)
      await ensureSelfHostedStudentMembership({
        profileId: '00000000-0000-4000-a000-000000000001',
        email: 'admin@example.com'
      });

      const members = await db.select().from(schema.organizationmember);
      const adminMember = members.find((m) => m.profileId === '00000000-0000-4000-a000-000000000001');

      expect(members.length).toBe(1); // Still 1 admin
      expect(adminMember?.roleId).toBe(ROLE.ADMIN); // Not degraded to STUDENT
    });
  });
});
