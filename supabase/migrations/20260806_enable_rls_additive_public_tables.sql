-- Enable Row Level Security on additive public tables that were created without it.
--
-- WHY: the Supabase linter (rls_disabled_in_public, ERROR) flagged 13 tables in the
-- PostgREST-exposed `public` schema with RLS disabled. Verified live-exploitable: the
-- project's public `anon` key could read private rows directly over /rest/v1 (reflections,
-- plaud transcripts) and held full DML (incl. TRUNCATE). The core `thoughts`/`entities`
-- tables already had RLS; these additive feature-migration tables never enabled it.
--
-- EFFECT: RLS enabled with NO policy => anon/authenticated are denied all access. OB's
-- server-side paths are UNAFFECTED because they use the service-role secret key
-- (sb_secret_..., BYPASSRLS) and SECURITY DEFINER RPCs (definer bypasses RLS). Data is
-- untouched — this changes access control only. Reversible: DISABLE ROW LEVEL SECURITY.
--
-- Applied live via the Management API on 2026-08-06 (Adam's direct in-session go) and
-- verified: anon reads now return empty; rest-api Edge Function reads still return 200;
-- pg_class.relrowsecurity = true on all 13.

ALTER TABLE public._dedupe_victims          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reflections              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_regen_queue         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_audit              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_task_receipts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_status_ledger      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.curation_queue           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_actions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duplicate_dismissals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaud_speaker_segments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaud_recordings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plaud_recording_speakers ENABLE ROW LEVEL SECURITY;

-- SECURE BY DEFAULT (standing rule, 2026-08-06): every NEW public table must enable RLS
-- in the same migration that creates it, and every NEW SECURITY DEFINER function must
-- REVOKE EXECUTE FROM anon, authenticated (or be SECURITY INVOKER). Relying on OB's
-- service-role key + x-brain-key Edge gate is NOT a substitute — a public table with RLS
-- off is world-readable via the anon key regardless of the Edge layer.
