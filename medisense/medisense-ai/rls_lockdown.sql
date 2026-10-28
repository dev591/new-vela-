-- VELA: lock the database down to the backend only.
--
-- Run in the Supabase SQL editor AFTER deploying the backend that uses
-- SUPABASE_SERVICE_ROLE_KEY for every table call (main.py). The service role
-- bypasses RLS, so the backend keeps working; the anon key that ships to
-- browsers (needed only for Supabase Auth sign-up / password reset) can no
-- longer read or write any table.
--
-- This supersedes the "DISABLE ROW LEVEL SECURITY" lines in supabase_fixes.sql.

-- 1. See what is open today (run this first and keep the output).
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 2. Turn RLS on for every table in public, and drop every policy that grants
--    anything to anon / authenticated / public. No replacement policies are
--    created on purpose: browsers never query tables directly.
DO $$
DECLARE
    t record;
    p record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tablename);
    END LOOP;

    FOR p IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
    END LOOP;
END $$;

-- 3. Belt and braces: remove the table privileges themselves, now and for
--    tables created later.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- 4. Verify: every row should say rowsecurity = true, and the policy list
--    should be empty (or contain only service_role policies).
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'public';
