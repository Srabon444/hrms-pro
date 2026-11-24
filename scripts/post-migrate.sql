create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
	if (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') then
		NEW.updated_at := OLD.updated_at;
	else
		NEW.updated_at := clock_timestamp();
	end if;
	return NEW;
end $$;

create or replace function audit_row() returns trigger
language plpgsql security invoker as $$
declare
	reg record;
	old_j jsonb;
	new_j jsonb;
	changed text[];
	masked text[];
	shown_old jsonb;
	shown_new jsonb;
	sens_old jsonb;
	sens_new jsonb;
	audit_id uuid;
	k text;
begin
	select * into reg from public.audit_registry where table_name = TG_TABLE_NAME;
	if not found or reg.mode = 'excluded' then
		return null;
	end if;
	if TG_OP <> 'INSERT' then old_j := to_jsonb(OLD) - 'updated_at' - 'created_at'; end if;
	if TG_OP <> 'DELETE' then new_j := to_jsonb(NEW) - 'updated_at' - 'created_at'; end if;

	if TG_OP = 'UPDATE' then
		select coalesce(array_agg(n.key order by n.key), '{}') into changed
		from jsonb_each(new_j) n
		where n.value is distinct from old_j -> n.key;
		if cardinality(changed) = 0 then
			return null;
		end if;
	else
		select coalesce(array_agg(x order by x), '{}') into changed from jsonb_object_keys(coalesce(new_j, old_j)) x;
	end if;

	if reg.mode = 'row_only' then
		insert into public.audit_log (tenant_id, actor_user_id, actor_kind, table_name, row_id, op, changed_columns)
		values (
			(coalesce(new_j, old_j) ->> 'tenant_id')::uuid,
			nullif(current_setting('app.user_id', true), '')::uuid,
			coalesce(nullif(current_setting('app.actor', true), ''), 'user'),
			TG_TABLE_NAME,
			(coalesce(new_j, old_j) ->> 'id')::uuid,
			TG_OP,
			changed
		);
		return null;
	end if;

	shown_old := '{}'::jsonb;
	shown_new := '{}'::jsonb;
	sens_old := '{}'::jsonb;
	sens_new := '{}'::jsonb;
	masked := '{}';
	foreach k in array changed loop
		if k = any(reg.plain_columns) then
			if old_j is not null then shown_old := shown_old || jsonb_build_object(k, old_j -> k); end if;
			if new_j is not null then shown_new := shown_new || jsonb_build_object(k, new_j -> k); end if;
		else
			masked := masked || k;
			if old_j is not null then
				shown_old := shown_old || jsonb_build_object(k, '***');
				sens_old := sens_old || jsonb_build_object(k, old_j -> k);
			end if;
			if new_j is not null then
				shown_new := shown_new || jsonb_build_object(k, '***');
				sens_new := sens_new || jsonb_build_object(k, new_j -> k);
			end if;
		end if;
	end loop;

	insert into public.audit_log (tenant_id, actor_user_id, actor_kind, table_name, row_id, op, changed_columns, old_values, new_values)
	values (
		(coalesce(new_j, old_j) ->> 'tenant_id')::uuid,
		nullif(current_setting('app.user_id', true), '')::uuid,
		coalesce(nullif(current_setting('app.actor', true), ''), 'user'),
		TG_TABLE_NAME,
		(coalesce(new_j, old_j) ->> 'id')::uuid,
		TG_OP,
		changed,
		case when old_j is null then null else shown_old end,
		case when new_j is null then null else shown_new end
	)
	returning id into audit_id;

	if cardinality(masked) > 0 then
		insert into public.audit_sensitive (tenant_id, audit_id, old_values, new_values)
		values (
			(coalesce(new_j, old_j) ->> 'tenant_id')::uuid,
			audit_id,
			case when old_j is null then null else sens_old end,
			case when new_j is null then null else sens_new end
		);
	end if;
	return null;
end $$;

create or replace function audit_inserted_rows() returns trigger
language plpgsql security invoker as $$
declare
	reg record;
begin
	select * into reg from public.audit_registry where table_name = TG_TABLE_NAME;
	if not found or reg.mode = 'excluded' then
		return null;
	end if;
	with src as (
		select gen_random_uuid() as audit_id, to_jsonb(n) - 'updated_at' - 'created_at' as j from new_rows n
	), keyed as (
		select s.audit_id, s.j, c.changed, c.masked
		from src s
		cross join lateral (
			select array_agg(k order by k) as changed, coalesce(array_agg(k order by k) filter (where not k = any(reg.plain_columns)), '{}') as masked
			from jsonb_object_keys(s.j) k
		) c
	), logged as (
		insert into public.audit_log (id, tenant_id, actor_user_id, actor_kind, table_name, row_id, op, changed_columns, new_values)
		select
			audit_id,
			(j ->> 'tenant_id')::uuid,
			nullif(current_setting('app.user_id', true), '')::uuid,
			coalesce(nullif(current_setting('app.actor', true), ''), 'user'),
			TG_TABLE_NAME,
			(j ->> 'id')::uuid,
			'INSERT',
			changed,
			case when reg.mode = 'row_only' then null
				else (select jsonb_object_agg(k, case when k = any(reg.plain_columns) then j -> k else to_jsonb('***'::text) end) from unnest(changed) k)
			end
		from keyed
	)
	insert into public.audit_sensitive (tenant_id, audit_id, new_values)
	select (j ->> 'tenant_id')::uuid, audit_id, (select jsonb_object_agg(k, j -> k) from unnest(masked) k)
	from keyed
	where reg.mode <> 'row_only' and cardinality(masked) > 0;
	return null;
end $$;

do $$
declare
	t record;
	tenant_expr constant text := $e$tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid$e$;
	access_expr text;
	p record;
	reg_mode text;
begin
	for t in
		select c.table_name
		from information_schema.columns c
		join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
		where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'
	loop
		execute format('alter table public.%I enable row level security', t.table_name);
		execute format('alter table public.%I force row level security', t.table_name);

		for p in select policyname from pg_policies where schemaname = 'public' and tablename = t.table_name and policyname like 'hrms\_%' loop
			execute format('drop policy %I on public.%I', p.policyname, t.table_name);
		end loop;

		execute format('create policy hrms_tenant on public.%I as restrictive for all to hrms_app using (%s) with check (%s)',
			t.table_name, tenant_expr, tenant_expr);

		select format('employee_id = nullif(current_setting(''app.employee_id'', true), '''')::uuid or current_setting(''app.%s'', true) = ''on''', o.flag)
		into access_expr from owner_row_tables o where o.table_name = t.table_name;

		if t.table_name = 'audit_sensitive' then
			execute format('create policy hrms_read on public.%I for select to hrms_app using (current_setting(''app.audit_sensitive'', true) = ''on'')', t.table_name);
			execute format('create policy hrms_write on public.%I for insert to hrms_app with check (true)', t.table_name);
		elsif access_expr is not null then
			execute format('create policy hrms_access on public.%I for all to hrms_app using (%s) with check (%s)', t.table_name, access_expr, access_expr);
		else
			execute format('create policy hrms_access on public.%I for all to hrms_app using (true) with check (true)', t.table_name);
		end if;

		execute format('revoke all on public.%I from public, hrms_app, hrms_auth', t.table_name);
		if t.table_name in ('audit_log', 'audit_sensitive') then
			execute format('grant select, insert on public.%I to hrms_app', t.table_name);
		else
			execute format('grant select, insert, update, delete on public.%I to hrms_app', t.table_name);
		end if;

		if t.table_name in ('memberships', 'invitations', 'tenant_settings') then
			execute format('create policy hrms_auth_read on public.%I for select to hrms_auth using (true)', t.table_name);
			execute format('grant select on public.%I to hrms_auth', t.table_name);
		end if;

		execute format('drop trigger if exists hrms_audit on public.%I', t.table_name);
		execute format('drop trigger if exists hrms_audit_insert on public.%I', t.table_name);
		select mode into reg_mode from audit_registry where table_name = t.table_name;
		if reg_mode is not null and reg_mode <> 'excluded' then
			execute format('create trigger hrms_audit after update or delete on public.%I for each row execute function audit_row()', t.table_name);
			execute format('create trigger hrms_audit_insert after insert on public.%I referencing new table as new_rows for each statement execute function audit_inserted_rows()', t.table_name);
		end if;
	end loop;

	for t in
		select c.table_name
		from information_schema.columns c
		join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
		where c.table_schema = 'public' and c.column_name = 'updated_at' and tb.table_type = 'BASE TABLE'
	loop
		execute format('drop trigger if exists hrms_touch on public.%I', t.table_name);
		execute format('create trigger hrms_touch before update on public.%I for each row execute function touch_updated_at()', t.table_name);
	end loop;
end $$;

revoke all on public.tenants, public.users, public.sessions, public.password_resets, public.platform_audit from public, hrms_app, hrms_auth;
grant select, insert, update on public.tenants to hrms_auth;
grant select, insert, update, delete on public.users, public.sessions, public.password_resets to hrms_auth;
grant select, insert on public.platform_audit to hrms_auth;
revoke all on public.audit_registry, public.owner_row_tables from public, hrms_app, hrms_auth;
grant select on public.audit_registry to hrms_app;

create or replace view public.tenant_users with (security_barrier) as
select
	m.tenant_id,
	m.id as membership_id,
	m.status as membership_status,
	m.employee_id,
	m.last_used_at,
	u.id as user_id,
	u.email,
	u.name,
	u.last_login_at,
	u.totp_enabled,
	u.status as user_status
from public.memberships m
join public.users u on u.id = m.user_id
where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;

revoke all on public.tenant_users from public, hrms_auth;
grant select on public.tenant_users to hrms_app;

create or replace function public.purge_audit() returns integer
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
	tid uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
	keep_days integer;
	removed integer;
begin
	if tid is null or current_setting('app.actor', true) is distinct from 'system' then
		raise exception 'purge_audit requires a system tenant context';
	end if;
	select retention_audit_days into keep_days from public.tenant_settings where tenant_id = tid;
	if keep_days is null or keep_days < 365 then
		raise exception 'retention_audit_days missing or below the 365 day floor';
	end if;
	delete from public.audit_log where tenant_id = tid and created_at < now() - make_interval(days => keep_days);
	get diagnostics removed = row_count;
	return removed;
end $$;

revoke all on function public.purge_audit() from public;
grant execute on function public.purge_audit() to hrms_app;

create or replace function public.auth_accept_invitation(p_token_hash text, p_user_id uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
	inv public.invitations%rowtype;
	usr public.users%rowtype;
	mid uuid;
begin
	select * into inv from public.invitations
	where token_hash = p_token_hash and accepted_at is null and revoked_at is null and expires_at > now()
	for update;
	if not found then
		raise exception 'invitation_invalid' using errcode = 'P0001';
	end if;
	if inv.invited_by_membership_id is not null and not exists (
		select 1 from public.memberships
		where id = inv.invited_by_membership_id and tenant_id = inv.tenant_id and status = 'active'
	) then
		raise exception 'invitation_invalid' using errcode = 'P0001';
	end if;
	if not exists (select 1 from public.tenants where id = inv.tenant_id and status = 'active') then
		raise exception 'invitation_invalid' using errcode = 'P0001';
	end if;
	select * into usr from public.users where id = p_user_id and status = 'active';
	if not found or usr.email <> inv.email then
		raise exception 'invitation_email_mismatch' using errcode = 'P0001';
	end if;

	insert into public.memberships (tenant_id, user_id, employee_id, status)
	values (inv.tenant_id, p_user_id, inv.employee_id, 'active')
	on conflict (tenant_id, user_id) do update
		set status = 'active', employee_id = coalesce(excluded.employee_id, public.memberships.employee_id), ex_access_until = null
		where public.memberships.status <> 'ex_employee'
	returning id into mid;
	if mid is null then
		raise exception 'invitation_invalid' using errcode = 'P0001';
	end if;

	insert into public.membership_roles (tenant_id, membership_id, role_id)
	select inv.tenant_id, mid, r.id
	from public.roles r
	where r.tenant_id = inv.tenant_id and (r.id = any(inv.role_ids) or r.key = 'employee')
	on conflict do nothing;

	update public.invitations set accepted_at = now() where id = inv.id;
	return mid;
end $$;

revoke all on function public.auth_accept_invitation(text, uuid) from public;
grant execute on function public.auth_accept_invitation(text, uuid) to hrms_auth;

update letter_templates set body = replace(body, 'BDT {{salary.', '{{salary.currency}} {{salary.') where body like '%BDT {{salary.%';

update attendance_days d set time_zone = s.timezone from tenant_settings s where s.tenant_id = d.tenant_id and d.time_zone is null;
