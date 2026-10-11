-- Addresses synthesized from a provider account id were stored as verified:
-- every Watcha account, and GitLab accounts that expose no email. Nobody
-- verified them, and better-auth links an existing account to a sign-in whose
-- verified email matches, so a provider that reported the same address as
-- verified could take the account over. Unverified, these accounts can still
-- sign in and link other providers explicitly.
UPDATE "user"
SET "emailVerified" = false
WHERE "emailVerified" = true
  AND ("email" LIKE '%@watcha.local' OR "email" LIKE '%@gitlab.local');
