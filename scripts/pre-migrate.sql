create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists pg_trgm;
create extension if not exists btree_gin;

do $$
declare
	app_pw text := current_setting('hrms.app_pw');
	auth_pw text := current_setting('hrms.auth_pw');
begin
	if not exists (select 1 from pg_roles where rolname = 'hrms_app') then
		execute format('create role hrms_app login nosuperuser nobypassrls nocreatedb nocreaterole password %L', app_pw);
	else
		execute format('alter role hrms_app login nosuperuser nobypassrls nocreatedb nocreaterole password %L', app_pw);
	end if;
	if not exists (select 1 from pg_roles where rolname = 'hrms_auth') then
		execute format('create role hrms_auth login nosuperuser nobypassrls nocreatedb nocreaterole password %L', auth_pw);
	else
		execute format('alter role hrms_auth login nosuperuser nobypassrls nocreatedb nocreaterole password %L', auth_pw);
	end if;
end $$;

grant usage on schema public to hrms_app, hrms_auth;
revoke create on schema public from public;
