import { PUBLIC_IS_SELFHOSTED } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getApiKeyHeaders } from '$lib/utils/services/api/server';
import { getOrgBySiteName } from '$features/org/api/org.server';
import { getSubdomain } from '$features/app/layout-setup';
import { redirect } from '@sveltejs/kit';
import { ROLE } from '@cio/utils/constants';

const APP_SUBDOMAINS = env.PRIVATE_APP_SUBDOMAINS?.split(',') || ['app'];
const ORG_ID_COOKIE_PREFIX = 'cio_org_id_';

export const load = async ({ params, url, cookies, locals }) => {
  const loadStart = performance.now();
  const subdomain = getSubdomain(url);
  const isOrgSite = subdomain && !APP_SUBDOMAINS.includes(subdomain);

  // If this is LMS but user is on org site, redirect to LMS
  if (isOrgSite && PUBLIC_IS_SELFHOSTED !== 'true') {
    console.log('isOrgSite redirecting to lms');
    redirect(307, `/lms`);
  }

  const siteName = params.slug;
  const cookieKey = `${ORG_ID_COOKIE_PREFIX}${siteName}`;
  const cachedOrgId = cookies.get(cookieKey);

  let orgId: string | undefined = cachedOrgId;
  let orgLookupMs = 0;

  if (!orgId) {
    const orgLookupStart = performance.now();
    const apiKeyHeaders = getApiKeyHeaders();
    const org = await getOrgBySiteName(siteName, apiKeyHeaders);
    orgLookupMs = Math.round((performance.now() - orgLookupStart) * 100) / 100;

    if (org?.id) {
      orgId = org.id;

      cookies.set(cookieKey, org.id, {
        path: '/',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        sameSite: 'lax',
        httpOnly: false // Allow client-side access if needed
      });
    }
  }

  // Phase 1 - Server-Side Routing Protection
  if (!locals.session) {
    redirect(302, '/login');
  }

  const userOrg = locals.organizations.find(
    (o: { id: string; siteName?: string }) => o.id === orgId || o.siteName === siteName
  );

  // If the user's role in this org is STUDENT, redirect to the student portal (/lms)
  if (userOrg?.member?.roleId === ROLE.STUDENT) {
    redirect(307, '/lms');
  }

  const loadMs = Math.round((performance.now() - loadStart) * 100) / 100;
  console.log(
    `[org/+layout.server] load: ${loadMs}ms | siteName=${siteName} orgIdCache=${cachedOrgId ? 'hit' : 'miss'} getOrgBySiteName: ${orgLookupMs}ms`
  );

  return {
    orgName: siteName,
    orgId
  };
};
