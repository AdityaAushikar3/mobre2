import { type DbOrTxClient } from '@cio/db/drizzle';
import * as schema from '@cio/db/schema';
import {
  getOrganizationMemberIdByOrgAndProfile,
  createOrganizationMember,
  getOrganizationById
} from '@cio/db/queries/organization';
import { getGroupMemberIdByGroupAndProfile, addGroupMember } from '@cio/db/queries/group';
import { getProfileById } from '@cio/db/queries/auth';
import { getCourseTeachers } from '@cio/db/queries/course/people';
import {
  assertStudentCapacityOrThrow,
  type StudentMilestoneNotification,
  notifyStudentMilestone
} from '../organization/student-limit';
import { ensureComplianceEnrollmentRecordsForProfiles } from './compliance';
import { invalidateOrgStats } from '@cio/core/utils/redis/org-stats-cache';
import { trackServerEvent, SERVER_EVENTS } from '@cio/analytics';
import { ROLE } from '@cio/utils/constants';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { buildEmailFromName, buildEmailBranding } from '@cio/email';
import { getWelcomeSessionIcs } from './session-invite';
import { enqueueTransactionalEmail } from '@api/services/jobs';

export type PostCommitSideEffects = {
  milestoneNotification: StudentMilestoneNotification | null;
  invalidateOrgId: string | null;
  trackAnalytics: {
    orgId: string;
    userId: string;
    courseId: string;
  } | null;
  emails: {
    courseId: string;
    courseName: string;
    orgName: string;
    organizationId: string;
    org: { siteName: string | null; customDomain: string | null; isCustomDomainVerified: boolean | null };
    branding: any;
    studentId: string;
    studentEmail: string;
    welcomeEmailMessage?: string | null;
  } | null;
};

export async function enrollStudentInCourseTransaction(
  tx: DbOrTxClient,
  order: typeof schema.courseOrder.$inferSelect,
  course: typeof schema.course.$inferSelect
): Promise<PostCommitSideEffects> {
  const userId = order.userId;
  const organizationId = order.organizationId;
  const courseId = order.courseId;
  const groupId = course.groupId!;

  const orgMemberId = await getOrganizationMemberIdByOrgAndProfile(organizationId, userId, tx);

  const userProfile = await getProfileById(userId, tx);
  const normalizedEmail = userProfile?.email?.toLowerCase().trim();
  if (!normalizedEmail) {
    throw new Error('User email not found');
  }

  let milestoneNotification: StudentMilestoneNotification | null = null;

  if (!orgMemberId) {
    milestoneNotification = await assertStudentCapacityOrThrow(organizationId, 1, tx, { deferNotification: true });

    await createOrganizationMember(
      {
        organizationId,
        roleId: ROLE.STUDENT,
        profileId: userId,
        email: normalizedEmail,
        verified: true
      },
      tx
    );
  }

  const groupMemberId = await getGroupMemberIdByGroupAndProfile(groupId, userId, tx);

  if (!groupMemberId) {
    await addGroupMember(
      {
        groupId,
        roleId: ROLE.STUDENT,
        profileId: userId,
        email: normalizedEmail
      },
      tx
    );
  }

  await ensureComplianceEnrollmentRecordsForProfiles([courseId], [userId], tx);

  const org = await getOrganizationById(organizationId, tx);

  return {
    milestoneNotification,
    invalidateOrgId: organizationId,
    trackAnalytics: {
      orgId: organizationId,
      userId,
      courseId
    },
    emails: {
      courseId,
      courseName: course.title,
      orgName: org!.name,
      organizationId,
      org: {
        siteName: org!.siteName,
        customDomain: org!.customDomain,
        isCustomDomainVerified: org!.isCustomDomainVerified
      },
      branding: buildEmailBranding({ name: org!.name, avatarUrl: org!.avatarUrl, theme: org!.theme }),
      studentId: userId,
      studentEmail: normalizedEmail,
      welcomeEmailMessage: course.metadata?.welcomeEmailMessage as string | undefined
    }
  };
}

export async function runPostCommitSideEffects(effects: PostCommitSideEffects) {
  if (effects.milestoneNotification) {
    notifyStudentMilestone(effects.milestoneNotification).catch((err) => console.error(err));
  }

  if (effects.invalidateOrgId) {
    invalidateOrgStats(effects.invalidateOrgId).catch((err) => console.error(err));
  }

  if (effects.trackAnalytics) {
    trackServerEvent({
      eventType: SERVER_EVENTS.ENROLLMENT_COMPLETED,
      orgId: effects.trackAnalytics.orgId,
      userId: effects.trackAnalytics.userId,
      courseId: effects.trackAnalytics.courseId,
      props: { path: 'paid-enrollment' }
    });
  }

  if (effects.emails) {
    sendStudentJoinEmails(effects.emails).catch((err) => console.error(err));
  }
}

async function sendStudentJoinEmails(input: NonNullable<PostCommitSideEffects['emails']>) {
  try {
    const loginUrl = getDashboardBaseUrl(input.org);
    const ics = await getWelcomeSessionIcs(input.courseId);
    await enqueueTransactionalEmail('studentCourseWelcome', {
      to: input.studentEmail,
      fields: {
        orgName: input.orgName,
        courseName: input.courseName,
        loginUrl,
        customMessage: input.welcomeEmailMessage ?? undefined,
        branding: input.branding
      },
      from: buildEmailFromName(`${input.orgName} (via ClassroomIO.com)`),
      idempotencyKey: `course-welcome:${input.courseId}:${input.studentId}`,
      ics,
      preference: { organizationId: input.organizationId, recipientProfileId: input.studentId }
    });
  } catch (error) {
    console.error('Failed to enqueue student welcome email:', error);
  }

  try {
    const teachers = await getCourseTeachers({ courseId: input.courseId });
    if (teachers.length === 0) return;

    const studentProfile = await getProfileById(input.studentId);
    const studentName = studentProfile?.fullname || input.studentEmail;
    const teacherEmails = teachers.map((t) => t.email).filter((e): e is string => !!e);

    if (teacherEmails.length === 0) return;

    await enqueueTransactionalEmail('teacherStudentJoined', {
      to: teacherEmails,
      fields: {
        courseName: input.courseName,
        studentName,
        studentEmail: input.studentEmail,
        branding: input.branding
      },
      from: buildEmailFromName('ClassroomIO'),
      idempotencyKey: `teacher-student-joined:${input.courseId}:${input.studentId}`,
      preference: { organizationId: input.organizationId }
    });
  } catch (error) {
    console.error('Failed to enqueue teacher join notification emails:', error);
  }
}
