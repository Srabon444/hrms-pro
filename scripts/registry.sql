create table if not exists audit_registry (
	table_name text primary key,
	mode text not null check (mode in ('plain', 'row_only', 'excluded')),
	plain_columns text[] not null default '{}'
);

create table if not exists owner_row_tables (
	table_name text primary key,
	flag text not null check (flag in ('payroll_all', 'salary_all'))
);

insert into audit_registry (table_name, mode, plain_columns) values
	('memberships', 'plain', '{id,tenant_id,user_id,employee_id,status,ex_access_until,last_used_at}'),
	('roles', 'plain', '{id,tenant_id,key,name,description,is_system,locked}'),
	('role_permissions', 'plain', '{id,tenant_id,role_id,permission,scope}'),
	('membership_roles', 'plain', '{id,tenant_id,membership_id,role_id}'),
	('invitations', 'plain', '{id,tenant_id,email,role_ids,employee_id,invited_by_membership_id,expires_at,accepted_at,revoked_at}'),
	('tenant_settings', 'plain', '{id,tenant_id,legal_name,logo_file_id,address,currency,timezone,fiscal_year_start_month,weekend_days,payroll_proration_basis,meal_payroll_lag_months,late_policy_count,late_policy_penalty,require2fa_for_sensitive,allow_single_admin_approval,retention_candidates_days,retention_tickets_days,retention_audit_days,ex_employee_access_days,employee_code_prefix}'),
	('files', 'plain', '{id,tenant_id,filename,mime,size,owner_type,owner_id,uploaded_by_user_id}'),
	('branches', 'plain', '{id,tenant_id,name,address}'),
	('departments', 'plain', '{id,tenant_id,name,parent_id,head_employee_id}'),
	('employees', 'plain', '{id,tenant_id,code,full_name,work_email,personal_email,phone,gender,blood_group,department_id,designation_id,grade_id,branch_id,manager_id,employment_type,join_date,probation_end_date,confirmation_date,status,exit_date,exit_reason}'),
	('employee_history', 'plain', '{id,tenant_id,employee_id,field,old_value,new_value,changed_by_user_id}'),
	('employee_contacts', 'plain', '{id,tenant_id,employee_id,name,relation,phone}'),
	('employee_education', 'plain', '{id,tenant_id,employee_id,degree,institution,passing_year}'),
	('employee_experience', 'plain', '{id,tenant_id,employee_id,company,title,start_date,end_date}'),
	('employee_documents', 'plain', '{id,tenant_id,employee_id,category,title,file_name,content_type,size_bytes,sha256,storage_key,expires_on,uploaded_by_user_id}'),
	('designations', 'plain', '{id,tenant_id,name}'),
	('grades', 'plain', '{id,tenant_id,name,rank}'),
	('holidays', 'plain', '{id,tenant_id,date,name}'),
	('counters', 'excluded', '{}'),
	('audit_log', 'excluded', '{}'),
	('audit_sensitive', 'excluded', '{}'),
	('notifications', 'excluded', '{}'),
	('notification_prefs', 'excluded', '{}')
on conflict (table_name) do update set mode = excluded.mode, plain_columns = excluded.plain_columns;
