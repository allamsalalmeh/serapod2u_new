DO $r$ BEGIN CREATE ROLE supabase_admin SUPERUSER; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE app_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'select gen_random_uuid()';
-- Stubs with the real names for unrelated triggers on documents (bodies irrelevant; their trigger DDL is real).
CREATE FUNCTION public.documents_ensure_company_id() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public.auto_generate_display_doc_no() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public.sa_documents_api_write_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public.sa_tenant_remainder_api_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF TG_OP = ''DELETE'' THEN RETURN OLD; END IF; RETURN NEW; END';
CREATE FUNCTION public.auto_post_payment_to_gl() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public.auto_post_document_to_gl() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public.messaging_invoice_timeline_trg() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
