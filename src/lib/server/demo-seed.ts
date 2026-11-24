import { and, count, eq } from 'drizzle-orm';
import { withTestNow } from './clock';
import { addDays } from './dates';
import {
	employees,
	expenseCategories,
	goals,
	interviews,
	leaveRequests,
	leaveTypes,
	loans,
	mealTypes,
	memberships,
	payComponents,
	pipelineStages,
	reviews,
	ticketCategories,
	timesheets
} from './db/schema';
import { saveAnnouncement } from './announcements';
import { assignAsset, returnAsset, saveAsset } from './assets';
import { commentOnTicket, createTicket, requesterAction, updateTicket } from './helpdesk';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from './employees';
import { log } from './log';
import { decideClaim, payClaim, saveCategory, submitClaim } from './expenses';
import { decideLeave, requestLeave } from './leave-requests';
import { decideLoan, requestLoan } from './loans';
import { issueBills } from './meal-bills';
import { chooseMeal, runMealDays } from './meal-orders';
import { mealSetup, saveMealType, saveVendor, setMealPrice } from './meals';
import { addHoliday, addOrgItem } from './org';
import { importPunches } from './attendance';
import { createCycle, finaliseReview, saveGoal, submitManager, submitSelf } from './performance';
import { acknowledgePolicy, savePolicy } from './policies';
import { saveProject, setProjectMember } from './projects';
import { addCandidate, makeOffer, moveCandidate, saveOpening, scheduleInterview, submitFeedback } from './recruitment';
import { decideTimesheet, logTime, submitWeek } from './timesheets';
import { approveRun, payRun, startRun } from './payroll';
import { pdfDoc, write } from './pdf';
import { addMember } from './platform/tenants';
import { loadAccess, userCtx, type Access, type requireMember } from './rbac/access';
import { decideSalary, proposeSalary } from './salaries';
import { saveSettings } from './settings';
import { confirmTaxYear, startTaxYear } from './tax';
import { systemCtx, withTenant, type TenantCtx } from './tenancy';
import { toGrantMap } from '../rbac/grants';
import { SYSTEM_ROLES } from '../rbac/permissions';

type Member = ReturnType<typeof requireMember>;

export type EnsureUser = (
	email: string,
	name: string,
	password: string,
	opts?: { isPlatformAdmin?: boolean; resetPassword?: boolean }
) => Promise<string>;

type Person = {
	key: string;
	name: string;
	login: string;
	title: string;
	dept: string | null;
	grade: string;
	branch: string;
	boss: string | null;
	join: string;
	status: 'active' | 'probation' | 'onboarding';
	gender: 'female' | 'male';
	basic: number;
	roles: string[];
	dob: string;
	area: string;
};

const HQ = 'Dhaka HQ';
const CTG = 'Chattogram Office';
const TODAY = '2026-11-24';
const at = <T>(date: string, time: string, fn: () => T): T => withTestNow(`${date}T${time}:00+06:00`, fn);

const workEmail = (name: string) => {
	const w = name.toLowerCase().split(' ');
	return `${w[0]}.${w[w.length - 1]}@nimbuslabs.example`;
};

const PEOPLE: Person[] = [
	[
		'tanvir',
		'Tanvir Ahmed Chowdhury',
		'owner@demo.local',
		'Chief Executive Officer',
		null,
		'Executive',
		HQ,
		null,
		'2023-01-02',
		'active',
		'male',
		180000,
		['owner'],
		'1982-03-14',
		'Gulshan 2, Dhaka'
	],
	[
		'sajid',
		'Sajid Rahman',
		'sajid.rahman@nimbuslabs.example',
		'Chief Technology Officer',
		'Engineering',
		'Executive',
		HQ,
		'tanvir',
		'2023-01-02',
		'active',
		'male',
		170000,
		['line_manager'],
		'1984-08-02',
		'Dhanmondi, Dhaka'
	],
	[
		'nusrat',
		'Nusrat Jahan Mim',
		'hr@demo.local',
		'Head of People',
		'People & HR',
		'Lead',
		HQ,
		'tanvir',
		'2023-02-01',
		'active',
		'female',
		110000,
		['hr_admin'],
		'1989-11-21',
		'Banani, Dhaka'
	],
	[
		'kamrul',
		'Kamrul Islam',
		'finance@demo.local',
		'Finance Manager',
		'Finance',
		'Lead',
		HQ,
		'tanvir',
		'2023-03-01',
		'active',
		'male',
		115000,
		['finance'],
		'1986-05-09',
		'Uttara, Dhaka'
	],
	[
		'arif',
		'Arif Hossain',
		'manager@demo.local',
		'Engineering Team Lead (Backend)',
		'Engineering',
		'Lead',
		HQ,
		'sajid',
		'2023-04-10',
		'active',
		'male',
		120000,
		['line_manager'],
		'1988-01-27',
		'Mirpur, Dhaka'
	],
	[
		'farhana',
		'Farhana Akter',
		'farhana.akter@nimbuslabs.example',
		'Engineering Team Lead (Frontend)',
		'Engineering',
		'Lead',
		HQ,
		'sajid',
		'2023-06-05',
		'active',
		'female',
		115000,
		['line_manager'],
		'1990-06-18',
		'Mohammadpur, Dhaka'
	],
	[
		'nazmul',
		'Nazmul Haque',
		'nazmul.haque@nimbuslabs.example',
		'QA Lead',
		'QA',
		'Lead',
		HQ,
		'sajid',
		'2023-07-03',
		'active',
		'male',
		90000,
		['line_manager'],
		'1987-12-05',
		'Badda, Dhaka'
	],
	[
		'anika',
		'Anika Tabassum',
		'anika.tabassum@nimbuslabs.example',
		'Product Manager',
		'Product',
		'Lead',
		HQ,
		'tanvir',
		'2023-08-14',
		'active',
		'female',
		105000,
		['line_manager'],
		'1991-02-11',
		'Bashundhara R/A, Dhaka'
	],
	[
		'rakib',
		'Rakib Hasan',
		'rakib.hasan@nimbuslabs.example',
		'Senior Software Engineer',
		'Engineering',
		'Senior',
		HQ,
		'arif',
		'2023-09-01',
		'active',
		'male',
		95000,
		[],
		'1992-09-30',
		'Rampura, Dhaka'
	],
	[
		'shahriar',
		'Shahriar Kabir',
		'shahriar.kabir@nimbuslabs.example',
		'Design Lead',
		'Design',
		'Lead',
		HQ,
		'tanvir',
		'2023-11-05',
		'active',
		'male',
		95000,
		['line_manager'],
		'1990-04-22',
		'Lalmatia, Dhaka'
	],
	[
		'shamima',
		'Shamima Nasrin',
		'shamima.nasrin@nimbuslabs.example',
		'Senior Software Engineer',
		'Engineering',
		'Senior',
		HQ,
		'arif',
		'2024-01-15',
		'active',
		'female',
		90000,
		[],
		'1993-07-08',
		'Shyamoli, Dhaka'
	],
	[
		'fahim',
		'Fahim Reza',
		'fahim.reza@nimbuslabs.example',
		'Sales Manager',
		'Sales',
		'Lead',
		CTG,
		'tanvir',
		'2024-02-11',
		'active',
		'male',
		95000,
		['line_manager'],
		'1988-10-16',
		'Agrabad, Chattogram'
	],
	[
		'rokeya',
		'Rokeya Sultana',
		'rokeya.sultana@nimbuslabs.example',
		'HR Executive',
		'People & HR',
		'Mid',
		HQ,
		'nusrat',
		'2024-03-03',
		'active',
		'female',
		58000,
		['hr_officer', 'meal_manager'],
		'1995-03-03',
		'Mirpur, Dhaka'
	],
	[
		'imran',
		'Imran Hossain',
		'staff@demo.local',
		'Software Engineer',
		'Engineering',
		'Mid',
		HQ,
		'farhana',
		'2024-05-20',
		'active',
		'male',
		70000,
		[],
		'1996-01-12',
		'Mohakhali, Dhaka'
	],
	[
		'lamia',
		'Lamia Parvin',
		'payroll@demo.local',
		'Accounts Executive',
		'Finance',
		'Mid',
		HQ,
		'kamrul',
		'2024-08-04',
		'active',
		'female',
		60000,
		['payroll_officer'],
		'1994-08-25',
		'Malibagh, Dhaka'
	],
	[
		'tasnim',
		'Tasnim Ferdous',
		'tasnim.ferdous@nimbuslabs.example',
		'Software Engineer',
		'Engineering',
		'Mid',
		HQ,
		'farhana',
		'2024-10-06',
		'active',
		'female',
		65000,
		[],
		'1997-05-19',
		'Uttara, Dhaka'
	],
	[
		'zahid',
		'Zahid Hasan',
		'zahid.hasan@nimbuslabs.example',
		'DevOps Engineer',
		'Engineering',
		'Mid',
		HQ,
		'sajid',
		'2025-02-02',
		'active',
		'male',
		85000,
		['it_asset_manager'],
		'1993-12-01',
		'Khilgaon, Dhaka'
	],
	[
		'maliha',
		'Maliha Khan',
		'maliha.khan@nimbuslabs.example',
		'UI/UX Designer',
		'Design',
		'Mid',
		HQ,
		'shahriar',
		'2025-03-16',
		'active',
		'female',
		62000,
		[],
		'1996-09-09',
		'Banasree, Dhaka'
	],
	[
		'rubel',
		'Rubel Mia',
		'rubel.mia@nimbuslabs.example',
		'Business Analyst',
		'Product',
		'Mid',
		HQ,
		'anika',
		'2025-07-01',
		'active',
		'male',
		68000,
		[],
		'1994-11-30',
		'Tejgaon, Dhaka'
	],
	[
		'imtiaz',
		'Imtiaz Ahmed',
		'imtiaz.ahmed@nimbuslabs.example',
		'Talent Acquisition Specialist',
		'People & HR',
		'Mid',
		HQ,
		'nusrat',
		'2025-09-07',
		'active',
		'male',
		62000,
		['recruiter'],
		'1995-06-14',
		'Farmgate, Dhaka'
	],
	[
		'sumaiya',
		'Sumaiya Akhter',
		'sumaiya.akhter@nimbuslabs.example',
		'QA Engineer',
		'QA',
		'Mid',
		HQ,
		'nazmul',
		'2025-11-02',
		'active',
		'female',
		55000,
		[],
		'1997-02-28',
		'Mirpur, Dhaka'
	],
	[
		'nabila',
		'Nabila Islam',
		'nabila.islam@nimbuslabs.example',
		'Sales Executive',
		'Sales',
		'Junior',
		CTG,
		'fahim',
		'2026-02-02',
		'active',
		'female',
		48000,
		[],
		'1999-04-04',
		'Halishahar, Chattogram'
	],
	[
		'tahsin',
		'Tahsin Alam',
		'tahsin.alam@nimbuslabs.example',
		'QA Engineer',
		'QA',
		'Junior',
		HQ,
		'nazmul',
		'2026-08-03',
		'probation',
		'male',
		42000,
		[],
		'1999-10-10',
		'Mirpur, Dhaka'
	],
	[
		'mehedi',
		'Mehedi Hasan',
		'mehedi.hasan@nimbuslabs.example',
		'Junior Software Engineer',
		'Engineering',
		'Junior',
		HQ,
		'arif',
		'2026-09-01',
		'probation',
		'male',
		45000,
		[],
		'2000-07-23',
		'Jatrabari, Dhaka'
	],
	[
		'ayesha',
		'Ayesha Siddiqua',
		'ayesha.siddiqua@nimbuslabs.example',
		'Junior Software Engineer',
		'Engineering',
		'Junior',
		HQ,
		'farhana',
		'2026-11-16',
		'onboarding',
		'female',
		45000,
		[],
		'2001-01-05',
		'Savar, Dhaka'
	]
].map(([key, name, login, title, dept, grade, branch, boss, join, status, gender, basic, roles, dob, area]) => ({
	key,
	name,
	login,
	title,
	dept,
	grade,
	branch,
	boss,
	join,
	status,
	gender,
	basic,
	roles,
	dob,
	area
})) as Person[];

const HOLIDAY_LIST: [string, string][] = [
	['2026-02-21', 'International Mother Language Day'],
	['2026-03-17', "Sheikh Mujibur Rahman's Birthday"],
	['2026-03-20', 'Eid-ul-Fitr'],
	['2026-03-21', 'Eid-ul-Fitr'],
	['2026-03-22', 'Eid-ul-Fitr'],
	['2026-03-26', 'Independence Day'],
	['2026-04-14', 'Pohela Boishakh'],
	['2026-05-01', 'May Day'],
	['2026-05-26', 'Eid-ul-Adha'],
	['2026-05-27', 'Eid-ul-Adha'],
	['2026-05-28', 'Eid-ul-Adha'],
	['2026-08-05', 'July Mass Uprising Day'],
	['2026-08-26', 'Eid-e-Miladunnabi'],
	['2026-09-04', 'Janmashtami'],
	['2026-10-20', 'Durga Puja'],
	['2026-12-16', 'Victory Day'],
	['2026-12-25', 'Christmas Day']
];

const TITLES = [...new Set(PEOPLE.map((p) => p.title))];
const DEPARTMENTS = ['Engineering', 'Product', 'Design', 'QA', 'People & HR', 'Finance', 'Sales'];
const GRADES = ['Junior', 'Mid', 'Senior', 'Lead', 'Executive'];
const BLOOD = ['A+', 'B+', 'O+', 'AB+', 'O-', 'B-'];

const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const ownerGrants = toGrantMap(
	SYSTEM_ROLES.find((r) => r.key === 'owner')!.grants.map(([permission, scope]) => ({ permission, scope }))
);
const creator: Access = { membershipId: '', employeeId: null, grants: ownerGrants, roleKeys: ['owner'], isOwner: true };

type Seat = { userId: string; membershipId: string; employeeId: string; m: Member };

export async function seedDemo(
	tenant: { id: string; slug: string; name: string },
	password: string,
	ensureUser: EnsureUser
): Promise<void> {
	const tenantId = tenant.id;
	const sys = systemCtx(tenantId);
	const userIds: Record<string, string> = {};
	for (const p of PEOPLE) {
		userIds[p.key] = await ensureUser(p.login, p.name, password, { resetPassword: true });
		await withTenant(sys, (tx) => addMember(tx, tenantId, userIds[p.key], p.roles));
	}
	const [{ n }] = await withTenant(sys, (tx) => tx.select({ n: count() }).from(employees));
	if (n > 0) {
		log.info({ tenant: tenant.slug, employees: n }, 'demo data already present, skipped');
		return;
	}

	await saveSettings(sys, {
		legalName: tenant.name,
		address: 'House 42, Road 11, Banani, Dhaka 1213',
		timezone: 'Asia/Dhaka',
		fiscalYearStartMonth: '7',
		weekendDays: ['5', '6'],
		employeeCodePrefix: 'NL-'
	});

	const org = {
		department: {} as Record<string, string>,
		designation: {} as Record<string, string>,
		grade: {} as Record<string, string>,
		branch: {} as Record<string, string>
	};
	for (const d of DEPARTMENTS) org.department[d] = await addOrgItem(sys, 'department', { name: d });
	for (const t of TITLES) org.designation[t] = await addOrgItem(sys, 'designation', { name: t });
	for (const [i, g] of GRADES.entries()) org.grade[g] = await addOrgItem(sys, 'grade', { name: g, rank: i + 1 });
	org.branch[HQ] = await addOrgItem(sys, 'branch', { name: HQ, address: 'House 42, Road 11, Banani, Dhaka 1213' });
	org.branch[CTG] = await addOrgItem(sys, 'branch', {
		name: CTG,
		address: '88 Sheikh Mujib Road, Agrabad, Chattogram 4100'
	});

	const empIds: Record<string, string> = {};
	for (const [i, p] of PEOPLE.entries()) {
		const probationEnd = p.status === 'probation' ? addDays(p.join, 182) : '';
		empIds[p.key] = await createEmployee(sys, creator, {
			...blanks,
			fullName: p.name,
			workEmail: workEmail(p.name),
			personalEmail: '',
			phone: `+88017${String(10000000 + i * 1234567).slice(0, 8)}`,
			dateOfBirth: p.dob,
			gender: p.gender,
			bloodGroup: BLOOD[i % BLOOD.length],
			presentAddress: p.area,
			permanentAddress: p.area,
			departmentId: p.dept ? org.department[p.dept] : '',
			designationId: org.designation[p.title],
			gradeId: org.grade[p.grade],
			branchId: org.branch[p.branch],
			managerId: p.boss ? empIds[p.boss] : '',
			employmentType: 'full_time',
			joinDate: p.join,
			probationEndDate: probationEnd,
			status: p.status
		});
	}
	await withTenant(sys, async (tx) => {
		for (const p of PEOPLE)
			await tx.update(memberships).set({ employeeId: empIds[p.key] }).where(eq(memberships.userId, userIds[p.key]));
	});

	const seats: Record<string, Seat> = {};
	for (const p of PEOPLE) {
		const [row] = await withTenant(sys, (tx) =>
			tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, userIds[p.key]))
		);
		seats[p.key] = {
			userId: userIds[p.key],
			membershipId: row.id,
			employeeId: empIds[p.key],
			m: {
				user: { userId: userIds[p.key] },
				tenant: { id: tenantId, slug: tenant.slug, name: tenant.name },
				access: await loadAccess(tenantId, { id: row.id, status: 'active', employeeId: empIds[p.key] })
			} as unknown as Member
		};
	}
	const root = {
		...seats.tanvir.m,
		access: { ...seats.tanvir.m.access, employeeId: null }
	} as Member;
	const demo: Demo = { tenant, sys, seats, emp: empIds, org, root };

	for (const [date, name] of HOLIDAY_LIST) await addHoliday(sys, { date, name });

	const comps = await withTenant(sys, (tx) => tx.select().from(payComponents));
	const comp = (code: string) => comps.find((c) => c.code === code)!.id;
	const lines = (basic: number) => ({
		[`c_${comp('BASIC')}`]: String(basic),
		[`c_${comp('HOUSE_RENT')}`]: '50',
		[`c_${comp('MEDICAL')}`]: basic >= 100000 ? '8000' : '5000',
		[`c_${comp('CONVEYANCE')}`]: basic >= 100000 ? '6000' : '3500'
	});
	const settle = async (key: string, from: string, basic: number, reason: string) => {
		const changeId = await proposeSalary(seats.lamia.m, {
			employeeId: empIds[key],
			effectiveFrom: from,
			reason,
			...lines(basic)
		});
		const decider = key === 'kamrul' ? seats.tanvir.m : seats.kamrul.m;
		await decideSalary(decider, { changeId, decision: 'approve', note: '' });
	};
	for (const p of PEOPLE) await settle(p.key, p.join, p.basic, 'Joining salary');
	for (const key of ['rakib', 'shamima', 'imran', 'tasnim', 'arif', 'farhana', 'nazmul', 'zahid'])
		await settle(
			key,
			'2026-07-01',
			Math.round((PEOPLE.find((p) => p.key === key)!.basic * 1.08) / 500) * 500,
			'Annual increment 2026'
		);

	await at('2026-07-01', '10:00', async () => {
		const taxYearId = await startTaxYear(seats.lamia.m, { fy: '2026-27' });
		await confirmTaxYear(seats.kamrul.m, { taxYearId });
	});

	await seedLeave(demo);
	await seedMeals(demo);
	await seedExpenses(demo);
	await seedLoans(demo);
	await seedPayroll(demo);
	await seedAttendance(demo);
	await seedHelpdesk(demo);
	await seedAssets(demo);
	await seedRecruitment(demo);
	await seedPerformance(demo);
	await seedProjects(demo);
	await seedAnnouncements(demo);
	await seedPolicies(demo);
}

type Demo = {
	tenant: { id: string; slug: string; name: string };
	sys: TenantCtx;
	seats: Record<string, Seat>;
	emp: Record<string, string>;
	org: Record<'department' | 'designation' | 'grade' | 'branch', Record<string, string>>;
	root: Member;
};

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const datesBetween = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
};
const HOLIDAYS = new Set(HOLIDAY_LIST.map(([d]) => d));
const working = (d: string) => dow(d) !== 5 && dow(d) !== 6 && !HOLIDAYS.has(d);

const pdf = async (title: string, lines: string[]) => {
	const { doc, done } = pdfDoc(title);
	write(doc, title, 48, 60, 500);
	lines.forEach((l, i) => write(doc, l, 48, 110 + i * 22, 500));
	doc.end();
	return done;
};
const pdfFile = async (name: string, title: string, lines: string[]) =>
	new File([(await pdf(title, lines)) as BlobPart], name);

type LeaveRow = {
	who: string;
	type: string;
	asked: string;
	from: string;
	to: string;
	reason: string;
	by: string;
	decision: 'approve' | 'reject' | null;
	note?: string;
};

const LEAVES: LeaveRow[] = [
	{
		who: 'rakib',
		type: 'earned',
		asked: '2026-10-01',
		from: '2026-10-18',
		to: '2026-10-22',
		reason: "Family trip to Cox's Bazar",
		by: 'arif',
		decision: 'approve'
	},
	{
		who: 'imran',
		type: 'casual',
		asked: '2026-10-04',
		from: '2026-10-08',
		to: '2026-10-08',
		reason: "Cousin's wedding",
		by: 'farhana',
		decision: 'approve'
	},
	{
		who: 'tasnim',
		type: 'sick',
		asked: '2026-10-12',
		from: '2026-10-12',
		to: '2026-10-13',
		reason: 'Viral fever, doctor advised rest',
		by: 'farhana',
		decision: 'approve'
	},
	{
		who: 'fahim',
		type: 'earned',
		asked: '2026-10-20',
		from: '2026-10-27',
		to: '2026-10-29',
		reason: 'Personal travel',
		by: 'tanvir',
		decision: 'reject',
		note: 'Quarter-end sales push, please move this to December.'
	},
	{
		who: 'shamima',
		type: 'casual',
		asked: '2026-10-27',
		from: '2026-11-02',
		to: '2026-11-03',
		reason: 'House shifting',
		by: 'arif',
		decision: 'approve'
	},
	{
		who: 'imtiaz',
		type: 'casual',
		asked: '2026-11-05',
		from: '2026-11-12',
		to: '2026-11-12',
		reason: 'Bank work',
		by: 'nusrat',
		decision: 'reject',
		note: 'Interview panel is scheduled that day.'
	},
	{
		who: 'anika',
		type: 'sick',
		asked: '2026-11-10',
		from: '2026-11-10',
		to: '2026-11-11',
		reason: 'Dental surgery',
		by: 'tanvir',
		decision: 'approve'
	},
	{
		who: 'maliha',
		type: 'earned',
		asked: '2026-10-15',
		from: '2026-11-08',
		to: '2026-11-12',
		reason: 'Visiting family in Rajshahi',
		by: 'shahriar',
		decision: 'approve'
	},
	{
		who: 'nabila',
		type: 'earned',
		asked: '2026-11-10',
		from: '2026-12-13',
		to: '2026-12-17',
		reason: 'Year-end holiday with family',
		by: 'fahim',
		decision: 'approve'
	},
	{
		who: 'rokeya',
		type: 'casual',
		asked: '2026-11-12',
		from: '2026-12-02',
		to: '2026-12-03',
		reason: "Sister's engagement",
		by: 'nusrat',
		decision: 'approve'
	},
	{
		who: 'farhana',
		type: 'casual',
		asked: '2026-11-16',
		from: '2026-11-18',
		to: '2026-11-18',
		reason: "Child's school event",
		by: 'sajid',
		decision: 'approve'
	},
	{
		who: 'zahid',
		type: 'earned',
		asked: '2026-11-20',
		from: '2026-12-06',
		to: '2026-12-10',
		reason: 'Trip to Sylhet',
		by: 'sajid',
		decision: null
	},
	{
		who: 'tahsin',
		type: 'casual',
		asked: '2026-11-23',
		from: '2026-11-29',
		to: '2026-11-30',
		reason: 'Visiting parents in Chattogram',
		by: 'nazmul',
		decision: null
	},
	{
		who: 'kamrul',
		type: 'earned',
		asked: '2026-11-18',
		from: '2026-12-20',
		to: '2026-12-24',
		reason: 'Family vacation',
		by: 'tanvir',
		decision: null
	},
	{
		who: 'sumaiya',
		type: 'casual',
		asked: '2026-11-24',
		from: '2026-11-26',
		to: '2026-11-26',
		reason: 'Passport office appointment',
		by: 'nazmul',
		decision: null
	},
	{
		who: 'rubel',
		type: 'sick',
		asked: '2026-11-24',
		from: '2026-11-24',
		to: '2026-11-24',
		reason: 'Migraine',
		by: 'anika',
		decision: null
	}
];

const approvedLeave = (key: string, d: string) =>
	LEAVES.some((l) => l.who === key && l.decision === 'approve' && d >= l.from && d <= l.to);

async function seedLeave(d: Demo) {
	const types = await withTenant(d.sys, (tx) => tx.select().from(leaveTypes));
	for (const l of LEAVES) {
		const typeId = types.find((t) => t.code === l.type)!.id;
		await at(l.asked, '10:00', () =>
			requestLeave(d.seats[l.who].m, {
				leaveTypeId: typeId,
				startDate: l.from,
				endDate: l.to,
				session: 'full',
				reason: l.reason
			})
		);
		if (!l.decision) continue;
		const [row] = await withTenant(d.sys, (tx) =>
			tx
				.select({ id: leaveRequests.id })
				.from(leaveRequests)
				.where(and(eq(leaveRequests.employeeId, d.emp[l.who]), eq(leaveRequests.startDate, l.from)))
		);
		await at(l.asked, '16:00', () =>
			decideLeave(d.seats[l.by].m, row.id, { decision: l.decision!, note: l.note ?? '' })
		);
	}
}

async function seedMeals(d: Demo) {
	const caterer = 'Bhojon Bari Catering';
	await saveVendor(d.sys, '', { name: caterer, contact: '+8801711000222', active: 'on' });
	const [vendor] = (await withTenant(d.sys, mealSetup)).vendors;
	await saveMealType(d.sys, '', { name: 'Office Lunch', vendorId: vendor.id, active: 'on' });
	const [type] = await withTenant(d.sys, (tx) => tx.select().from(mealTypes));
	await at('2026-08-31', '10:00', () =>
		setMealPrice(d.sys, { mealTypeId: type.id, effectiveFrom: '2026-09-01', unitCost: '180', subsidyPct: '40' })
	);
	const start = '2026-09-01';
	for (const day of datesBetween(start, TODAY)) {
		const n = datesBetween(start, day).length;
		if (working(day))
			for (const [i, p] of PEOPLE.entries()) {
				if (p.join > day || approvedLeave(p.key, day)) continue;
				const out = (i * 5 + n * 3) % 7 === 0;
				const guest = !out && (i + n * 2) % 19 === 0;
				if (!out && !guest) continue;
				await at(day, '08:30', () =>
					chooseMeal(d.seats[p.key].m, {
						date: day,
						mealTypeId: type.id,
						status: out ? 'opted_out' : 'ordered',
						guestQty: guest ? '1' : '0'
					})
				);
			}
		await at(day, '18:30', () => runMealDays(d.tenant.id));
		if (day === '2026-10-02') await at(day, '19:00', () => issueBills(d.root, { period: '2026-09' }));
		if (day === '2026-11-02') await at(day, '19:00', () => issueBills(d.root, { period: '2026-10' }));
	}
}

async function seedExpenses(d: Demo) {
	const fin = d.seats.kamrul.m;
	for (const [name, limit] of [
		['Travel', '15000'],
		['Client entertainment', ''],
		['Software and subscriptions', ''],
		['Office supplies', '6000']
	])
		await saveCategory(fin, '', { name, claimLimit: limit, active: 'on' });
	const cats = await withTenant(d.sys, (tx) => tx.select().from(expenseCategories));
	const cat = (name: string) => cats.find((c) => c.name === name)!.id;
	const item = (i: number, category: string, spentOn: string, description: string, amount: string) => ({
		[`items.${i}.categoryId`]: cat(category),
		[`items.${i}.spentOn`]: spentOn,
		[`items.${i}.description`]: description,
		[`items.${i}.amount`]: amount
	});
	type Claim = {
		who: string;
		asked: string;
		title: string;
		items: [string, string, string, string][];
		by?: string;
		decision?: 'approve' | 'reject';
		payVia?: 'direct' | 'payroll';
		note?: string;
		paid?: string;
	};
	const claims: Claim[] = [
		{
			who: 'fahim',
			asked: '2026-10-08',
			title: 'Client visit to Sylhet',
			items: [
				['Travel', '2026-10-05', 'Bus fare Dhaka to Sylhet, return', '2400'],
				['Travel', '2026-10-05', 'Hotel, one night', '4500'],
				['Travel', '2026-10-06', 'Local transport', '850']
			],
			by: 'tanvir',
			decision: 'approve',
			payVia: 'payroll'
		},
		{
			who: 'imran',
			asked: '2026-10-12',
			title: 'PostgreSQL performance course',
			items: [['Software and subscriptions', '2026-10-10', 'Online course enrolment', '4500']],
			by: 'farhana',
			decision: 'approve',
			payVia: 'direct',
			paid: '2026-10-15'
		},
		{
			who: 'anika',
			asked: '2026-10-20',
			title: 'Product workshop supplies',
			items: [['Office supplies', '2026-10-18', 'Sticky notes, markers and whiteboard', '3200']],
			by: 'tanvir',
			decision: 'approve',
			payVia: 'payroll'
		},
		{
			who: 'zahid',
			asked: '2026-11-03',
			title: 'Cloud conference ticket',
			items: [['Software and subscriptions', '2026-11-01', 'Conference registration', '12000']],
			by: 'sajid',
			decision: 'approve',
			payVia: 'payroll'
		},
		{
			who: 'tasnim',
			asked: '2026-11-15',
			title: 'Mechanical keyboard',
			items: [['Office supplies', '2026-11-14', 'Keyboard from Star Tech', '4800']],
			by: 'farhana',
			decision: 'reject',
			note: 'Please raise a request with IT for hardware instead.'
		},
		{
			who: 'maliha',
			asked: '2026-11-20',
			title: 'Design tool licence',
			items: [['Software and subscriptions', '2026-11-19', 'Icon library, annual licence', '3900']],
			by: 'shahriar',
			decision: 'approve',
			payVia: 'direct'
		},
		{
			who: 'rakib',
			asked: '2026-11-12',
			title: 'Co-working day pass',
			items: [['Office supplies', '2026-11-11', 'Day pass during power outage', '1200']]
		},
		{
			who: 'nabila',
			asked: '2026-11-18',
			title: 'Client meeting travel, Chattogram',
			items: [
				['Travel', '2026-11-17', 'CNG and bus fare', '1800'],
				['Client entertainment', '2026-11-17', 'Tea and snacks with client', '950']
			]
		},
		{
			who: 'shahriar',
			asked: '2026-11-22',
			title: 'Client lunch',
			items: [['Client entertainment', '2026-11-21', 'Lunch with Meridian Retail team', '5600']]
		}
	];
	for (const c of claims) {
		const form: Record<string, string> = { title: c.title };
		c.items.forEach(([category, spentOn, desc, amount], i) =>
			Object.assign(form, item(i, category, spentOn, desc, amount))
		);
		const files = new Map<number, File>();
		files.set(
			0,
			await pdfFile('receipt.pdf', `Receipt: ${c.items[0][2]}`, [
				`Amount: BDT ${c.items[0][3]}`,
				`Date: ${c.items[0][1]}`,
				`Paid by: ${PEOPLE.find((p) => p.key === c.who)!.name}`
			])
		);
		const claimId = await at(c.asked, '12:00', () => submitClaim(d.seats[c.who].m, form, files));
		if (!c.decision) continue;
		await at(c.asked, '17:00', () =>
			decideClaim(d.seats[c.by!].m, {
				claimId,
				decision: c.decision!,
				payVia: c.payVia ?? 'direct',
				note: c.note ?? ''
			})
		);
		if (c.paid) await at(c.paid, '11:00', () => payClaim(fin, { claimId }));
	}
}

async function seedLoans(d: Demo) {
	const fin = d.seats.kamrul.m;
	const rows: {
		who: string;
		asked: string;
		kind: 'loan' | 'advance';
		amount: string;
		n: string;
		start: string;
		reason: string;
		decide?: 'approve' | 'reject';
		on?: string;
	}[] = [
		{
			who: 'imran',
			asked: '2026-10-03',
			kind: 'loan',
			amount: '60000',
			n: '6',
			start: '2026-10',
			reason: 'Down payment for a laptop and furniture',
			decide: 'approve',
			on: '2026-10-05'
		},
		{
			who: 'rokeya',
			asked: '2026-11-09',
			kind: 'advance',
			amount: '15000',
			n: '1',
			start: '2026-11',
			reason: 'Medical expenses for a family member',
			decide: 'approve',
			on: '2026-11-10'
		},
		{
			who: 'tasnim',
			asked: '2026-11-23',
			kind: 'loan',
			amount: '30000',
			n: '3',
			start: '2026-12',
			reason: 'Home internet and relocation deposit'
		}
	];
	for (const r of rows) {
		await at(r.asked, '10:30', () =>
			requestLoan(d.seats[r.who].m, {
				kind: r.kind,
				amount: r.amount,
				instalments: r.n,
				startPeriod: r.start,
				reason: r.reason
			})
		);
		if (!r.decide) continue;
		const [loan] = await withTenant(d.sys, (tx) => tx.select().from(loans).where(eq(loans.employeeId, d.emp[r.who])));
		await at(r.on!, '14:00', () => decideLoan(fin, { loanId: loan.id, decision: r.decide!, note: '' }));
	}
}

async function seedPayroll(d: Demo) {
	const runId = await at('2026-11-04', '11:00', () => startRun(d.seats.lamia.m, { period: '2026-10' }));
	await at('2026-11-04', '16:00', () => approveRun(d.seats.kamrul.m, { runId }));
	await at('2026-11-05', '10:00', () => payRun(d.seats.kamrul.m, { runId }));
}

const rng = (seed: number) => () => {
	seed = (seed * 1664525 + 1013904223) % 4294967296;
	return seed / 4294967296;
};
const hhmm = (mins: number) =>
	`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

async function seedAttendance(d: Demo) {
	const rows = await withTenant(d.sys, (tx) => tx.select({ id: employees.id, code: employees.code }).from(employees));
	const code = (key: string) => rows.find((r) => r.id === d.emp[key])!.code;
	const absent = new Set([
		'tahsin:2026-11-04',
		'mehedi:2026-11-10',
		'rubel:2026-11-17',
		'rakib:2026-11-19',
		'nabila:2026-11-11'
	]);
	const habitual = new Set(['mehedi', 'maliha', 'tasnim']);
	const next = rng(2026);
	const table: string[][] = [['employee_code', 'timestamp']];
	for (const day of datesBetween('2026-11-01', TODAY).filter(working))
		for (const p of PEOPLE) {
			if (p.join > day || approvedLeave(p.key, day) || absent.has(`${p.key}:${day}`)) continue;
			if (day === TODAY && p.key === 'rubel') continue;
			const late = next() < (habitual.has(p.key) ? 0.35 : 0.06);
			const arrive = late ? 9 * 60 + 20 + Math.floor(next() * 40) : 8 * 60 + 35 + Math.floor(next() * 35);
			table.push([code(p.key), `${day} ${hhmm(arrive)}`]);
			if (day < TODAY) table.push([code(p.key), `${day} ${hhmm(17 * 60 + 50 + Math.floor(next() * 55))}`]);
		}
	await at(TODAY, '12:00', () => importPunches(d.root, table));
}

type TicketStep = {
	day: string;
	by: string;
	status?: string;
	priority?: string;
	assign?: boolean;
	comment?: string;
	internal?: boolean;
	action?: 'close' | 'reopen';
};

async function seedHelpdesk(d: Demo) {
	const rows = await withTenant(d.sys, (tx) =>
		tx.select({ id: ticketCategories.id, name: ticketCategories.name }).from(ticketCategories)
	);
	const category = (name: string) => rows.find((r) => r.name.toLowerCase() === name.toLowerCase())!.id;
	const tickets: {
		who: string;
		category: string;
		subject: string;
		description: string;
		priority: string;
		on: string;
		steps: TicketStep[];
	}[] = [
		{
			who: 'imran',
			category: 'IT support',
			subject: 'VPN drops every few minutes when working from home',
			description:
				'The office VPN disconnects roughly every five minutes since last Friday. I have to reconnect and lose my SSH sessions each time.',
			priority: 'high',
			on: '2026-11-18',
			steps: [
				{
					day: '2026-11-18',
					by: 'zahid',
					status: 'in_progress',
					assign: true,
					comment: 'Looking at the gateway logs now. Which ISP are you on?'
				},
				{
					day: '2026-11-19',
					by: 'imran',
					comment: 'Link3 broadband. It started right after the router firmware update.'
				},
				{
					day: '2026-11-20',
					by: 'zahid',
					comment: 'Found a keepalive mismatch on our side. Rolling a fix to the gateway on Sunday.',
					internal: false
				}
			]
		},
		{
			who: 'tasnim',
			category: 'IT support',
			subject: 'Second monitor flickers',
			description: 'The external monitor on my desk flickers every few seconds, mostly when the screen is bright.',
			priority: 'normal',
			on: '2026-11-10',
			steps: [
				{
					day: '2026-11-10',
					by: 'zahid',
					status: 'in_progress',
					assign: true,
					comment: 'I will swap the cable today.'
				},
				{
					day: '2026-11-12',
					by: 'zahid',
					status: 'resolved',
					comment: 'Replaced the HDMI cable. Please tell me if it comes back.'
				},
				{ day: '2026-11-13', by: 'tasnim', action: 'close' }
			]
		},
		{
			who: 'maliha',
			category: 'Payroll',
			subject: 'Conveyance allowance missing from the October payslip',
			description: 'My October payslip shows no conveyance allowance, but it was there in September.',
			priority: 'normal',
			on: '2026-11-06',
			steps: [
				{
					day: '2026-11-06',
					by: 'rokeya',
					status: 'in_progress',
					assign: true,
					comment: 'Checking the salary structure with finance.'
				},
				{
					day: '2026-11-09',
					by: 'rokeya',
					status: 'waiting',
					comment: 'Finance is verifying the change. I will confirm by Thursday.'
				}
			]
		},
		{
			who: 'sumaiya',
			category: 'HR query',
			subject: 'How much annual leave can I carry forward?',
			description: 'Can I carry unused earned leave into the next fiscal year, and is there a cap?',
			priority: 'low',
			on: '2026-11-23',
			steps: []
		},
		{
			who: 'rubel',
			category: 'Facilities',
			subject: 'Air conditioner not working in the Banani meeting room',
			description: 'The AC in the second floor meeting room stopped cooling. We have client calls there all week.',
			priority: 'urgent',
			on: '2026-11-20',
			steps: [
				{
					day: '2026-11-20',
					by: 'nusrat',
					status: 'in_progress',
					assign: true,
					comment: 'Technician booked for Wednesday morning.'
				},
				{
					day: '2026-11-20',
					by: 'nusrat',
					comment: 'Vendor quoted a gas refill. Approved up to 6,000 taka.',
					internal: true
				}
			]
		},
		{
			who: 'nabila',
			category: 'Grievance',
			subject: 'Concern about last minute client travel',
			description:
				'I have been asked to travel to client sites on a day notice several times this month without a plan for rest days.',
			priority: 'normal',
			on: '2026-11-17',
			steps: [
				{
					day: '2026-11-18',
					by: 'nusrat',
					status: 'in_progress',
					assign: true,
					comment:
						'Thank you for raising this. I would like to talk it through this week. Please pick a time that suits you.'
				}
			]
		},
		{
			who: 'mehedi',
			category: 'HR query',
			subject: 'What happens at the end of probation?',
			description: 'Could you explain how the probation review works and when I will hear about confirmation?',
			priority: 'low',
			on: '2026-11-05',
			steps: [
				{
					day: '2026-11-06',
					by: 'rokeya',
					status: 'resolved',
					assign: true,
					comment:
						'Your manager and HR review you in the sixth month. You will get a written confirmation letter about a week before the probation end date.'
				}
			]
		},
		{
			who: 'arif',
			category: 'IT support',
			subject: 'Staging cluster access for the new joiner',
			description: 'Please give Mehedi Hasan read access to the staging Kubernetes cluster.',
			priority: 'normal',
			on: '2026-11-19',
			steps: [
				{
					day: '2026-11-19',
					by: 'zahid',
					status: 'resolved',
					assign: true,
					comment: 'Access granted through the engineering group. He may need to log out and in again.'
				}
			]
		}
	];
	for (const t of tickets) {
		const { id } = await at(t.on, '10:15', () =>
			createTicket(d.seats[t.who].m, {
				categoryId: category(t.category),
				subject: t.subject,
				description: t.description,
				priority: t.priority
			})
		);
		let assignee = '';
		let priority = t.priority;
		let status = 'open';
		for (const [i, s] of t.steps.entries()) {
			const time = `${String(11 + i).padStart(2, '0')}:30`;
			await at(s.day, time, async () => {
				const seat = d.seats[s.by];
				if (s.action) {
					await requesterAction(seat.m, { ticketId: id, action: s.action });
					return;
				}
				if (s.comment)
					await commentOnTicket(seat.m, { ticketId: id, body: s.comment, internal: s.internal ? 'on' : '' });
				if (!s.status && !s.assign) return;
				if (s.assign) assignee = seat.membershipId;
				status = s.status ?? status;
				priority = s.priority ?? priority;
				await updateTicket(seat.m, { ticketId: id, status, priority, assignee });
			});
		}
	}
}

async function seedAssets(d: Demo) {
	const manager = d.seats.zahid.m;
	type Item = {
		tag: string;
		name: string;
		category: string;
		bought: string;
		cost: string;
		holder?: string;
		since?: string;
		condition?: string;
		back?: [string, string, string];
	};
	const items: Item[] = [
		{
			tag: 'LAP-001',
			name: 'MacBook Pro 14-inch M3',
			category: 'Laptop',
			bought: '2023-12-12',
			cost: '295000',
			holder: 'tanvir',
			since: '2023-12-15',
			condition: 'new'
		},
		{
			tag: 'LAP-002',
			name: 'MacBook Pro 14-inch M3',
			category: 'Laptop',
			bought: '2024-02-01',
			cost: '295000',
			holder: 'sajid',
			since: '2024-02-05',
			condition: 'new'
		},
		{
			tag: 'LAP-003',
			name: 'Dell Latitude 5440',
			category: 'Laptop',
			bought: '2023-04-03',
			cost: '135000',
			holder: 'arif',
			since: '2023-04-10',
			condition: 'new'
		},
		{
			tag: 'LAP-004',
			name: 'Dell Latitude 5440',
			category: 'Laptop',
			bought: '2023-05-29',
			cost: '135000',
			holder: 'farhana',
			since: '2023-06-05',
			condition: 'new'
		},
		{
			tag: 'LAP-005',
			name: 'Dell Latitude 5450',
			category: 'Laptop',
			bought: '2024-05-10',
			cost: '148000',
			holder: 'imran',
			since: '2024-05-20',
			condition: 'new'
		},
		{
			tag: 'LAP-006',
			name: 'Lenovo ThinkPad T14',
			category: 'Laptop',
			bought: '2023-08-24',
			cost: '142000',
			holder: 'rakib',
			since: '2023-09-01',
			condition: 'new'
		},
		{
			tag: 'LAP-007',
			name: 'Lenovo ThinkPad T14',
			category: 'Laptop',
			bought: '2024-01-08',
			cost: '142000',
			holder: 'shamima',
			since: '2024-01-15',
			condition: 'new'
		},
		{
			tag: 'LAP-008',
			name: 'Dell Latitude 5450',
			category: 'Laptop',
			bought: '2024-09-28',
			cost: '148000',
			holder: 'tasnim',
			since: '2024-10-06',
			condition: 'new'
		},
		{
			tag: 'LAP-009',
			name: 'MacBook Air 13-inch M2',
			category: 'Laptop',
			bought: '2025-03-10',
			cost: '165000',
			holder: 'maliha',
			since: '2025-03-16',
			condition: 'new'
		},
		{
			tag: 'LAP-010',
			name: 'Dell Latitude 5450',
			category: 'Laptop',
			bought: '2026-08-20',
			cost: '152000',
			holder: 'mehedi',
			since: '2026-09-01',
			condition: 'new'
		},
		{
			tag: 'LAP-011',
			name: 'Dell Latitude 5450',
			category: 'Laptop',
			bought: '2026-07-25',
			cost: '152000',
			holder: 'tahsin',
			since: '2026-08-03',
			condition: 'new'
		},
		{
			tag: 'LAP-012',
			name: 'Lenovo ThinkPad T14',
			category: 'Laptop',
			bought: '2026-11-05',
			cost: '158000',
			holder: 'ayesha',
			since: '2026-11-16',
			condition: 'new'
		},
		{ tag: 'LAP-013', name: 'Lenovo ThinkPad T14', category: 'Laptop', bought: '2026-11-05', cost: '158000' },
		{
			tag: 'LAP-014',
			name: 'HP ProBook 440 G9',
			category: 'Laptop',
			bought: '2025-12-10',
			cost: '118000',
			holder: 'nabila',
			since: '2026-02-02',
			condition: 'new',
			back: ['2026-10-15', 'damaged', 'Cracked hinge and a dead keyboard row.']
		},
		{
			tag: 'LAP-015',
			name: 'Dell Latitude 5420',
			category: 'Laptop',
			bought: '2023-01-16',
			cost: '128000',
			holder: 'rubel',
			since: '2025-07-01',
			condition: 'good',
			back: ['2026-08-30', 'good', 'Replaced with a newer machine.']
		},
		{
			tag: 'MON-001',
			name: 'Dell U2723QE 27-inch monitor',
			category: 'Monitor',
			bought: '2023-08-24',
			cost: '64000',
			holder: 'rakib',
			since: '2023-09-01',
			condition: 'new'
		},
		{
			tag: 'MON-002',
			name: 'Dell U2723QE 27-inch monitor',
			category: 'Monitor',
			bought: '2024-05-10',
			cost: '64000',
			holder: 'imran',
			since: '2024-05-20',
			condition: 'new'
		},
		{
			tag: 'MON-003',
			name: 'LG 27UP850 27-inch monitor',
			category: 'Monitor',
			bought: '2025-03-10',
			cost: '58000',
			holder: 'maliha',
			since: '2025-03-16',
			condition: 'new'
		},
		{ tag: 'MON-004', name: 'LG 27UP850 27-inch monitor', category: 'Monitor', bought: '2026-11-05', cost: '58000' },
		{
			tag: 'PHN-001',
			name: 'Samsung Galaxy A54',
			category: 'Mobile phone',
			bought: '2024-03-01',
			cost: '52000',
			holder: 'fahim',
			since: '2024-03-04',
			condition: 'new'
		}
	];
	await at(TODAY, '12:00', async () => {
		for (const [i, it] of items.entries()) {
			const assetId = await saveAsset(manager, {
				assetId: '',
				tag: it.tag,
				name: it.name,
				category: it.category,
				serial: `NL${String(i + 1).padStart(3, '0')}-${it.tag.replace('-', '')}-${2023 + (i % 4)}`,
				purchaseDate: it.bought,
				purchaseCost: it.cost,
				status: '',
				notes: ''
			});
			if (!it.holder) continue;
			await assignAsset(manager, {
				assetId,
				employeeId: d.emp[it.holder],
				assignedOn: it.since!,
				condition: it.condition!
			});
			if (it.back)
				await returnAsset(manager, {
					assetId,
					outcome: 'returned',
					returnedOn: it.back[0],
					condition: it.back[1],
					charge: '',
					note: it.back[2]
				});
		}
	});
}

async function seedRecruitment(d: Demo) {
	const ctx = userCtx(d.seats.imtiaz.m);
	const slug = d.tenant.slug;
	const opening = (
		title: string,
		department: string,
		designation: string,
		headcount: string,
		description: string,
		on: string
	) =>
		at(on, '10:00', () =>
			saveOpening(ctx, {
				title,
				departmentId: d.org.department[department],
				designationId: d.org.designation[designation],
				headcount,
				status: 'open',
				description
			})
		);
	const backend = await opening(
		'Senior Backend Engineer',
		'Engineering',
		'Senior Software Engineer',
		'2',
		'Own services written in TypeScript and PostgreSQL. Design APIs, review code and mentor engineers. Five or more years of experience.',
		'2026-10-12'
	);
	const designer = await opening(
		'Product Designer',
		'Design',
		'UI/UX Designer',
		'1',
		'Design web and mobile flows from research to hand-off. Strong portfolio and experience with design systems.',
		'2026-11-02'
	);
	const stagesOf = async (openingId: string) => {
		const rows = await withTenant(d.sys, (tx) =>
			tx
				.select({ id: pipelineStages.id, name: pipelineStages.name })
				.from(pipelineStages)
				.where(eq(pipelineStages.openingId, openingId))
		);
		return (name: string) => rows.find((r) => r.name === name)!.id;
	};
	const stageOf = { [backend]: await stagesOf(backend), [designer]: await stagesOf(designer) };
	type Applicant = {
		openingId: string;
		name: string;
		source: string;
		tags: string;
		notes: string;
		resume: boolean;
		applied: string;
		path: [string, string, string][];
	};
	const people: Applicant[] = [
		{
			openingId: backend,
			name: 'Mahmudul Hasan',
			source: 'referral',
			tags: 'node,postgres,lead',
			notes: 'Referred by Rakib Hasan. Seven years at a payments company.',
			resume: true,
			applied: '2026-10-20',
			path: [
				['Screening', '2026-10-22', 'Phone screen went well'],
				['Interview', '2026-10-27', 'Technical round booked'],
				['Offer', '2026-11-05', 'Panel recommends an offer']
			]
		},
		{
			openingId: backend,
			name: 'Sadia Afrin',
			source: 'job_board',
			tags: 'typescript,aws',
			notes: 'Strong system design answers on the phone screen.',
			resume: true,
			applied: '2026-11-05',
			path: [
				['Screening', '2026-11-07', ''],
				['Interview', '2026-11-12', 'Technical round booked']
			]
		},
		{
			openingId: backend,
			name: 'Tahmid Chowdhury',
			source: 'website',
			tags: 'java,spring',
			notes: '',
			resume: true,
			applied: '2026-11-16',
			path: [['Screening', '2026-11-19', 'Call on Thursday']]
		},
		{
			openingId: backend,
			name: 'Ishtiaq Karim',
			source: 'job_board',
			tags: 'node',
			notes: '',
			resume: false,
			applied: '2026-11-22',
			path: []
		},
		{
			openingId: backend,
			name: 'Farzana Yeasmin',
			source: 'agency',
			tags: 'golang',
			notes: '',
			resume: true,
			applied: '2026-11-02',
			path: [
				['Screening', '2026-11-04', ''],
				['Rejected', '2026-11-09', 'Salary expectation is far above the band']
			]
		},
		{
			openingId: designer,
			name: 'Nafisa Anjum',
			source: 'referral',
			tags: 'figma,research',
			notes: 'Referred by Maliha Khan. Portfolio includes a banking app redesign.',
			resume: true,
			applied: '2026-11-12',
			path: [
				['Screening', '2026-11-14', ''],
				['Interview', '2026-11-18', 'Design review booked']
			]
		},
		{
			openingId: designer,
			name: 'Raihan Kabir',
			source: 'walk_in',
			tags: 'illustration,figma',
			notes: '',
			resume: true,
			applied: '2026-11-13',
			path: [['Screening', '2026-11-17', '']]
		},
		{
			openingId: designer,
			name: 'Mou Akter',
			source: 'job_board',
			tags: 'ux',
			notes: '',
			resume: false,
			applied: '2026-11-23',
			path: []
		}
	];
	const ids: Record<string, string> = {};
	for (const [i, p] of people.entries()) {
		const file = p.resume
			? await pdfFile('resume.pdf', p.name, [
					'Curriculum vitae',
					`Applied: ${p.applied}`,
					`Skills: ${p.tags.replaceAll(',', ', ')}`
				])
			: null;
		ids[p.name] = await at(p.applied, '11:00', () =>
			addCandidate(
				ctx,
				{
					openingId: p.openingId,
					fullName: p.name,
					email: `${p.name.toLowerCase().replaceAll(' ', '.')}@example.com`,
					phone: `+88018${String(20000000 + i * 2345671).slice(0, 8)}`,
					source: p.source,
					tags: p.tags,
					notes: p.notes
				},
				file
			)
		);
		for (const [stage, day, note] of p.path)
			await at(day, '15:00', () =>
				moveCandidate(ctx, { candidateId: ids[p.name], stageId: stageOf[p.openingId](stage), note })
			);
	}

	const panel = (...keys: string[]) => keys.map((k) => d.seats[k].membershipId);
	const interview = (candidate: string, made: string, title: string, scheduledAt: string, keys: string[]) =>
		at(made, '10:00', () =>
			scheduleInterview(
				ctx,
				slug,
				{
					candidateId: ids[candidate],
					title,
					scheduledAt,
					durationMinutes: '60',
					location: 'Banani office, meeting room 2'
				},
				panel(...keys)
			)
		);
	const interviewIdOf = async (candidate: string, title: string) => {
		const [row] = await withTenant(d.sys, (tx) =>
			tx
				.select({ id: interviews.id })
				.from(interviews)
				.where(and(eq(interviews.candidateId, ids[candidate]), eq(interviews.title, title)))
		);
		return row.id;
	};
	const feedback = async (candidate: string, title: string, day: string, rows: [string, string, string, string][]) => {
		const interviewId = await interviewIdOf(candidate, title);
		for (const [key, rating, recommendation, comments] of rows)
			await at(day, '14:00', () =>
				submitFeedback(ctx, d.seats[key].membershipId, { interviewId, rating, recommendation, comments })
			);
	};

	await interview('Mahmudul Hasan', '2026-10-27', 'Technical interview', '2026-11-03T10:00', ['nusrat', 'tanvir']);
	await feedback('Mahmudul Hasan', 'Technical interview', '2026-11-03', [
		['tanvir', '5', 'strong_yes', 'Excellent depth on Postgres internals and a clear approach to trade-offs.'],
		['nusrat', '4', 'yes', 'Good communicator and a good culture fit.']
	]);
	await at('2026-11-06', '12:00', () =>
		makeOffer(ctx, {
			candidateId: ids['Mahmudul Hasan'],
			monthlyGross: '165000',
			joinDate: '2027-01-03',
			expiresOn: '2026-12-05',
			note: 'Includes the standard festival bonus and health insurance.'
		})
	);

	await interview('Sadia Afrin', '2026-11-12', 'Technical interview', '2026-11-18T11:00', ['imtiaz', 'nusrat']);
	await feedback('Sadia Afrin', 'Technical interview', '2026-11-18', [
		['imtiaz', '4', 'yes', 'Solid system design and good examples from past projects.'],
		['nusrat', '4', 'yes', 'Clear and thoughtful. Notice period is 30 days.']
	]);
	await interview('Sadia Afrin', '2026-11-19', 'Final round with the CTO', '2026-11-27T11:00', ['tanvir']);
	await interview('Nafisa Anjum', '2026-11-18', 'Portfolio review', '2026-11-25T14:00', ['nusrat', 'imtiaz']);
}

async function seedPerformance(d: Demo) {
	const hr = d.seats.nusrat.m;
	const { cycleId } = await at('2026-11-02', '10:00', () =>
		createCycle(hr, { name: 'Half-year review 2026', periodStart: '2026-07-01', periodEnd: '2026-12-31' })
	);
	const found = await withTenant(d.sys, (tx) =>
		tx.select({ id: reviews.id, employeeId: reviews.employeeId }).from(reviews).where(eq(reviews.cycleId, cycleId))
	);
	const reviewOf = (key: string) => found.find((r) => r.employeeId === d.emp[key])!.id;
	const plans: Record<
		string,
		{ goals: [string, string, number][]; reach: 'goals' | 'manager' | 'hr' | 'done'; self: number[]; boss: number[] }
	> = {
		rakib: {
			goals: [
				['Ship the payments reconciliation service', 'In production by the end of Q4', 40],
				['Reduce p95 API latency', 'Under 250 ms', 30],
				['Mentor two junior engineers', 'Fortnightly 1:1s', 30]
			],
			reach: 'done',
			self: [4, 5, 4],
			boss: [5, 4, 4]
		},
		shamima: {
			goals: [
				['Migrate billing jobs to the new queue', 'Zero missed runs', 50],
				['Raise unit test coverage', '75 percent on core modules', 30],
				['Write runbooks for on-call', 'Three runbooks', 20]
			],
			reach: 'hr',
			self: [4, 4, 5],
			boss: [4, 3, 4]
		},
		imran: {
			goals: [
				['Deliver the invoice export feature', 'Released and adopted by two clients', 50],
				['Cut flaky end-to-end tests', 'Under 2 percent failures', 30],
				['Complete the PostgreSQL course', 'Certificate', 20]
			],
			reach: 'manager',
			self: [4, 3, 5],
			boss: []
		},
		farhana: {
			goals: [
				['Lead the design system rollout in the web app', 'All screens migrated', 50],
				['Hire one frontend engineer', 'Offer accepted', 30],
				['Improve Lighthouse scores', 'Above 90', 20]
			],
			reach: 'manager',
			self: [4, 4, 4],
			boss: []
		},
		anika: {
			goals: [
				['Launch the Atlas mobile beta', 'Beta with 500 users', 50],
				['Run quarterly customer interviews', 'Ten interviews', 30],
				['Publish the product roadmap', 'Shared with all teams', 20]
			],
			reach: 'done',
			self: [5, 4, 4],
			boss: [5, 4, 4]
		},
		tasnim: {
			goals: [
				['Build the reporting dashboard API', 'Released in December', 60],
				['Improve code review turnaround', 'Under one working day', 40]
			],
			reach: 'goals',
			self: [],
			boss: []
		},
		mehedi: {
			goals: [
				['Complete the onboarding project', 'Merged to main', 50],
				['Learn the deployment pipeline', 'Ship one change unaided', 50]
			],
			reach: 'goals',
			self: [],
			boss: []
		}
	};
	const bossOf = (key: string) => PEOPLE.find((p) => p.key === key)!.boss!;
	for (const [key, plan] of Object.entries(plans)) {
		const reviewId = reviewOf(key);
		const mine = d.seats[key].m;
		for (const [title, target, weight] of plan.goals)
			await at('2026-11-05', '11:00', () =>
				saveGoal(mine, { reviewId, goalId: '', title, target, weight: String(weight) })
			);
		if (plan.reach === 'goals') continue;
		const goalIds = (
			await withTenant(d.sys, (tx) =>
				tx.select({ id: goals.id, title: goals.title }).from(goals).where(eq(goals.reviewId, reviewId))
			)
		).sort((a, b) => plan.goals.findIndex((g) => g[0] === a.title) - plan.goals.findIndex((g) => g[0] === b.title));
		const form = (prefix: string, values: number[]) =>
			Object.fromEntries(goalIds.map((g, i) => [`${prefix}.${g.id}`, String(values[i])]));
		const actual = Object.fromEntries(
			goalIds.map((g, i) => [
				`actual.${g.id}`,
				['Completed ahead of plan', 'On track, most of the work is done', 'Completed'][i % 3]
			])
		);
		await at('2026-11-12', '16:00', () =>
			submitSelf(mine, {
				reviewId,
				comments: 'Good half year. Happy to discuss the goals in our review.',
				...actual,
				...form('rating', plan.self)
			})
		);
		if (plan.reach === 'manager') continue;
		await at('2026-11-18', '15:00', () =>
			submitManager(d.seats[bossOf(key)].m, {
				reviewId,
				comments: 'Reliable delivery and good teamwork this period.',
				...form('rating', plan.boss)
			})
		);
		if (plan.reach === 'hr') continue;
		await at('2026-11-20', '11:00', () => finaliseReview(hr, { reviewId, share: 'on' }));
	}
}

async function seedProjects(d: Demo) {
	const owner = d.seats.tanvir.m;
	const defs: {
		code: string;
		name: string;
		client: string;
		billable: boolean;
		note: string;
		team: [string, 'lead' | 'member', number][];
	}[] = [
		{
			code: 'ATLAS',
			name: 'Atlas Mobile Banking App',
			client: 'Meridian Bank',
			billable: true,
			note: 'Feature work and code review',
			team: [
				['arif', 'lead', 50],
				['rakib', 'member', 70],
				['shamima', 'member', 80],
				['imran', 'member', 40],
				['maliha', 'member', 30],
				['sumaiya', 'member', 50],
				['anika', 'member', 20]
			]
		},
		{
			code: 'PULSE',
			name: 'Pulse Retail Analytics',
			client: 'Meridian Retail',
			billable: true,
			note: 'Dashboards and data pipeline',
			team: [
				['farhana', 'lead', 50],
				['tasnim', 'member', 100],
				['imran', 'member', 60],
				['maliha', 'member', 50],
				['sumaiya', 'member', 50],
				['rubel', 'member', 50]
			]
		},
		{
			code: 'PLATFORM',
			name: 'Internal Platform Modernisation',
			client: '',
			billable: false,
			note: 'Infrastructure and tooling',
			team: [
				['zahid', 'lead', 40],
				['mehedi', 'member', 60],
				['rakib', 'member', 30],
				['shamima', 'member', 20],
				['arif', 'member', 20]
			]
		}
	];
	const projectIds: Record<string, string> = {};
	for (const p of defs) {
		projectIds[p.code] = await saveProject(owner, {
			projectId: '',
			code: p.code,
			name: p.name,
			client: p.client,
			status: 'active',
			billable: p.billable ? 'on' : ''
		});
		for (const [key, role, allocation] of p.team)
			await setProjectMember(owner, {
				projectId: projectIds[p.code],
				employeeId: d.emp[key],
				role,
				allocation: String(allocation)
			});
	}
	const people = new Map<string, { code: string; note: string; allocation: number }[]>();
	for (const p of defs)
		for (const [key, , allocation] of p.team)
			people.set(key, [...(people.get(key) ?? []), { code: p.code, note: p.note, allocation }]);
	const days = datesBetween('2026-11-01', addDays(TODAY, -1)).filter(working);
	for (const [key, mine] of people) {
		const total = mine.reduce((sum, m) => sum + m.allocation, 0);
		for (const day of days) {
			if (approvedLeave(key, day) || PEOPLE.find((p) => p.key === key)!.join > day) continue;
			for (const m of mine) {
				const hours = Math.max(0.25, Math.round(((8 * m.allocation) / total) * 4) / 4);
				await at(day, '18:00', () =>
					logTime(d.seats[key].m, { projectId: projectIds[m.code], workDate: day, hours: String(hours), note: m.note })
				);
			}
		}
	}
	const sheets = await withTenant(d.sys, (tx) =>
		tx
			.select({ id: timesheets.id, employeeId: timesheets.employeeId, weekStart: timesheets.weekStart })
			.from(timesheets)
	);
	const keyOf = (employeeId: string) => Object.keys(d.emp).find((k) => d.emp[k] === employeeId)!;
	const waiting = new Set(['imran', 'tasnim', 'shamima']);
	for (const s of sheets) {
		if (s.weekStart > '2026-11-15') continue;
		const key = keyOf(s.employeeId);
		await at(addDays(s.weekStart, 4), '17:30', () => submitWeek(d.seats[key].m, { weekStart: s.weekStart }));
		const boss = d.seats[PEOPLE.find((p) => p.key === key)!.boss!].m;
		const recent = s.weekStart === '2026-11-15';
		if (recent && waiting.has(key)) continue;
		const reject = recent && key === 'maliha';
		await at(addDays(s.weekStart, 7), '10:00', () =>
			decideTimesheet(
				boss,
				s.id,
				reject
					? { decision: 'rejected', note: 'Please split the Pulse and Atlas hours for each day.' }
					: { decision: 'approved', note: '' }
			)
		);
	}
}

async function seedAnnouncements(d: Demo) {
	const hr = d.seats.nusrat.m;
	const rows: {
		on: string;
		title: string;
		body: string;
		audience: string;
		departmentId?: string;
		branchId?: string;
		pinned: boolean;
		expires: string;
	}[] = [
		{
			on: '2026-11-16',
			title: 'Welcome Ayesha Siddiqua to the team',
			body: 'Ayesha joined us this week as a Junior Software Engineer in the Frontend team under Farhana Akter. Please say hello and help her settle in.',
			audience: 'all',
			pinned: false,
			expires: ''
		},
		{
			on: '2026-11-20',
			title: 'Victory Day holiday: office closed on 16 December',
			body: 'The office will be closed on Wednesday 16 December for Victory Day. Plan your releases and client deliveries around the holiday. Support will respond on the next working day.',
			audience: 'all',
			pinned: true,
			expires: '2026-12-17'
		},
		{
			on: '2026-11-23',
			title: 'Code freeze ahead of the Atlas release',
			body: 'Engineering will freeze the main branch from Sunday 6 December for the Atlas beta release. Only fixes approved by your team lead will be merged until the release is tagged.',
			audience: 'department',
			departmentId: d.org.department['Engineering'],
			pinned: false,
			expires: '2026-12-10'
		},
		{
			on: '2026-11-22',
			title: 'Chattogram office network maintenance',
			body: 'The internet provider will upgrade the line at the Agrabad office on Thursday between 2 pm and 5 pm. Please plan for limited connectivity or work from home that afternoon.',
			audience: 'branch',
			branchId: d.org.branch[CTG],
			pinned: false,
			expires: '2026-11-27'
		}
	];
	for (const r of rows)
		await at(r.on, '09:00', () =>
			saveAnnouncement(hr, {
				announcementId: '',
				title: r.title,
				body: r.body,
				audience: r.audience,
				departmentId: r.departmentId ?? '',
				branchId: r.branchId ?? '',
				pinned: r.pinned ? 'on' : '',
				publishOn: r.on,
				expiresOn: r.expires
			})
		);
}

async function seedPolicies(d: Demo) {
	const hr = d.seats.nusrat.m;
	const defs: { on: string; title: string; description: string; ack: boolean; lines: string[]; readers: string[] }[] = [
		{
			on: '2026-10-15',
			title: 'Code of Conduct',
			description: 'How we treat each other, our clients and company property.',
			ack: true,
			lines: [
				'1. Treat colleagues and clients with respect.',
				'2. Report harassment or discrimination to People and HR.',
				'3. Declare conflicts of interest.',
				'4. Protect company and client data.'
			],
			readers: PEOPLE.filter((p) => p.join <= '2026-10-31' && p.key !== 'rubel' && p.key !== 'zahid').map((p) => p.key)
		},
		{
			on: '2026-11-09',
			title: 'Information Security Policy',
			description: 'Rules for devices, passwords, access and handling client data.',
			ack: true,
			lines: [
				'1. Lock your screen when you step away.',
				'2. Use the password manager and two-factor sign in.',
				'3. Never share production credentials.',
				'4. Report lost devices within one hour.'
			],
			readers: [
				'tanvir',
				'sajid',
				'nusrat',
				'kamrul',
				'arif',
				'farhana',
				'nazmul',
				'rakib',
				'shamima',
				'imran',
				'zahid',
				'lamia'
			]
		},
		{
			on: '2026-09-01',
			title: 'Remote Work Guidelines',
			description: 'Working from home: availability, equipment and expenses.',
			ack: false,
			lines: [
				'1. Keep core hours from 10 am to 4 pm available.',
				'2. Use the office VPN for internal systems.',
				'3. Tell your manager the day before.'
			],
			readers: []
		}
	];
	for (const p of defs) {
		const file = await pdfFile(`${p.title.toLowerCase().replaceAll(' ', '-')}.pdf`, p.title, p.lines);
		const { id } = await at(p.on, '10:00', () =>
			savePolicy(
				hr,
				{ policyId: '', title: p.title, description: p.description, requiresAck: p.ack ? 'on' : '', active: 'on' },
				file
			)
		);
		for (const [i, key] of p.readers.entries())
			await at(addDays(p.on, 1 + (i % 4)), '11:00', () =>
				acknowledgePolicy(d.seats[key].m, { policyId: id, version: '1' })
			);
	}
}
