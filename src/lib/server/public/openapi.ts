const id = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date' };
const time = { type: ['string', 'null'], pattern: '^\\d{2}:\\d{2}$' };
const text = { type: ['string', 'null'] };

const list = (permission: string, item: Record<string, unknown>, ranged: boolean, summary: string) => ({
	get: {
		summary,
		description: `Needs a key that can use ${permission}. Rows follow the scope the key was given, narrowed to what its creator can read today.`,
		security: [{ bearer: [] }],
		parameters: [
			...(ranged
				? [
						{ name: 'from', in: 'query', required: true, schema: date },
						{ name: 'to', in: 'query', required: true, schema: date, description: 'At most 366 days after from.' }
					]
				: []),
			{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
			{ name: 'cursor', in: 'query', schema: id, description: 'nextCursor from the previous page.' }
		],
		responses: {
			'200': {
				description: 'One page, ordered by id.',
				content: {
					'application/json': {
						schema: {
							type: 'object',
							properties: {
								data: { type: 'array', items: { type: 'object', properties: item } },
								nextCursor: { ...id, type: ['string', 'null'] }
							}
						}
					}
				}
			},
			'400': { $ref: '#/components/responses/problem' },
			'401': { $ref: '#/components/responses/problem' },
			'403': { $ref: '#/components/responses/problem' },
			'429': { $ref: '#/components/responses/problem' }
		}
	}
});

const employee = {
	id,
	code: { type: 'string' },
	fullName: { type: 'string' },
	workEmail: text,
	department: text,
	designation: text,
	managerId: { ...id, type: ['string', 'null'] },
	branchId: { ...id, type: ['string', 'null'] },
	employmentType: { type: 'string' },
	joinDate: date,
	status: { type: 'string' },
	exitDate: { ...date, type: ['string', 'null'] }
};

export const OPENAPI = {
	openapi: '3.1.0',
	info: {
		title: 'HRMS Pro API',
		version: '1',
		description:
			'Read-only access for other systems. Make a key under Settings → API keys. Each key can make 600 requests a minute. Send GET requests only; any body must be JSON.'
	},
	servers: [{ url: '/api/v1' }],
	components: {
		securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'hrp_<prefix>_<secret>' } },
		responses: {
			problem: {
				description: 'An error.',
				content: {
					'application/json': {
						schema: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }
					}
				}
			}
		}
	},
	paths: {
		'/employees': list('employee.read', employee, false, 'List employees'),
		'/employees/{id}': {
			get: {
				summary: 'One employee',
				security: [{ bearer: [] }],
				parameters: [{ name: 'id', in: 'path', required: true, schema: id }],
				responses: {
					'200': {
						description: 'The employee.',
						content: {
							'application/json': {
								schema: { type: 'object', properties: { data: { type: 'object', properties: employee } } }
							}
						}
					},
					'401': { $ref: '#/components/responses/problem' },
					'403': { $ref: '#/components/responses/problem' },
					'404': { $ref: '#/components/responses/problem' },
					'429': { $ref: '#/components/responses/problem' }
				}
			}
		},
		'/leave-requests': list(
			'leave.read',
			{
				id,
				employeeId: id,
				leaveType: { type: 'string' },
				startDate: date,
				endDate: date,
				session: { enum: ['full', 'am', 'pm'] },
				days: { type: 'number' },
				status: { enum: ['pending', 'approved', 'rejected', 'cancelled'] },
				decidedAt: { type: ['string', 'null'], format: 'date-time' }
			},
			true,
			'Leave requests that overlap the dates'
		),
		'/attendance-days': list(
			'attendance.read',
			{
				id,
				employeeId: id,
				date,
				status: { type: 'string' },
				firstIn: { type: ['string', 'null'], format: 'date-time' },
				lastOut: { type: ['string', 'null'], format: 'date-time' },
				workedMinutes: { type: 'integer' },
				lateMinutes: { type: 'integer' }
			},
			true,
			'Attendance days between the dates'
		),
		'/roster': list(
			'schedule.read',
			{ id, employeeId: id, date, kind: { enum: ['work', 'off'] }, shift: text, startTime: time, endTime: time },
			true,
			'Published roster between the dates (needs the schedule module)'
		),
		'/events': list(
			'calendar.read',
			{
				id,
				title: { type: 'string' },
				description: text,
				location: text,
				startDate: date,
				endDate: date,
				startTime: time,
				endTime: time,
				audience: { type: 'string' },
				departmentId: { ...id, type: ['string', 'null'] },
				branchId: { ...id, type: ['string', 'null'] }
			},
			true,
			'Events the key creator can see between the dates (needs the events module)'
		)
	}
};
