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
	('tenant_settings', 'plain', '{id,tenant_id,legal_name,logo_file_id,address,currency,timezone,fiscal_year_start_month,weekend_days,payroll_proration_basis,meal_payroll_lag_months,late_policy_count,late_policy_penalty,require2fa_for_sensitive,allow_single_admin_approval,retention_candidates_days,retention_tickets_days,retention_audit_days,ex_employee_access_days,employee_code_prefix,notice_period_days}'),
	('files', 'plain', '{id,tenant_id,filename,mime,size,owner_type,owner_id,uploaded_by_user_id}'),
	('branches', 'plain', '{id,tenant_id,name,address}'),
	('departments', 'plain', '{id,tenant_id,name,parent_id,head_employee_id}'),
	('employees', 'plain', '{id,tenant_id,code,full_name,work_email,personal_email,phone,gender,blood_group,department_id,designation_id,grade_id,branch_id,manager_id,employment_type,join_date,probation_end_date,confirmation_date,status,exit_date,exit_reason,exit_type}'),
	('employee_history', 'plain', '{id,tenant_id,employee_id,field,old_value,new_value,changed_by_user_id}'),
	('employee_contacts', 'plain', '{id,tenant_id,employee_id,name,relation,phone}'),
	('employee_education', 'plain', '{id,tenant_id,employee_id,degree,institution,passing_year}'),
	('employee_experience', 'plain', '{id,tenant_id,employee_id,company,title,start_date,end_date}'),
	('change_requests', 'plain', '{id,tenant_id,employee_id,requested_by_user_id,status,decided_by_user_id,decided_at,decision_note}'),
	('leave_types', 'plain', '{id,tenant_id,code,name,paid,quota,accrual,pro_rata,carry_cap,encashable,max_consecutive,min_notice_days,half_day_allowed,gender,during_probation,sandwich,active}'),
	('leave_ledger', 'plain', '{id,tenant_id,employee_id,leave_type_id,fiscal_year,kind,days,period,ref_id,expires_on,created_by_user_id}'),
	('leave_requests', 'plain', '{id,tenant_id,employee_id,leave_type_id,start_date,end_date,session,days,status,requested_by_user_id,decided_by_user_id,decided_at,decision_note}'),
	('leave_request_days', 'plain', '{id,tenant_id,request_id,employee_id,date,session,fiscal_year,status}'),
	('shifts', 'plain', '{id,tenant_id,name,start_time,end_time,grace_minutes,half_day_minutes,full_day_minutes,is_default,active}'),
	('shift_assignments', 'plain', '{id,tenant_id,employee_id,shift_id,effective_from,created_by_user_id}'),
	('checklist_templates', 'plain', '{id,tenant_id,kind,name,active}'),
	('checklist_template_items', 'plain', '{id,tenant_id,template_id,title,assignee_role,due_offset_days}'),
	('checklists', 'plain', '{id,tenant_id,employee_id,template_id,kind,name,anchor_date}'),
	('checklist_items', 'plain', '{id,tenant_id,checklist_id,title,assignee_role,due_date,done_at,done_by_user_id}'),
	('exit_interviews', 'plain', '{id,tenant_id,employee_id,exit_date,primary_reason,rating,would_recommend,would_rejoin,submitted_by_user_id}'),
	('resignations', 'plain', '{id,tenant_id,employee_id,requested_by_user_id,submitted_on,notice_days,requested_last_day,status,manager_user_id,manager_at,decided_by_user_id,decided_at,approved_last_day}'),
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
