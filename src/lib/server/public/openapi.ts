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
			'Read-only access for other systems, plus a punch endpoint for attendance devices. Make a key under Settings → API keys; each key can make 600 requests a minute and sends GET requests only. Attendance devices use their own keys from Settings → Attendance devices. Any body must be JSON.'
	},
	servers: [{ url: '/api/v1' }],
	components: {
		securitySchemes: {
			bearer: { type: 'http', scheme: 'bearer', description: 'hrp_<prefix>_<secret>' },
			device: { type: 'http', scheme: 'bearer', description: 'hrd_<prefix>_<secret>' }
		},
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
		'/punches': {
			post: {
				summary: 'Send punches from an attendance device',
				description:
					'Needs a device key (hrd_<prefix>_<secret>) from Settings → Attendance devices; an API key cannot send punches. Up to 500 punches per request and 60 requests a minute per device. A punch is matched by deviceUserId, or by employeeCode when deviceUserId is missing. Punches older than 31 days or more than 5 minutes ahead are rejected. A punch already recorded for that person at that moment counts as a duplicate. A punch in a month whose payroll is already approved is stored and flagged for HR to review.',
				security: [{ device: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['punches'],
								properties: {
									punches: {
										type: 'array',
										minItems: 1,
										maxItems: 500,
										items: {
											type: 'object',
											required: ['at'],
											properties: {
												deviceUserId: { type: 'string', maxLength: 32 },
												employeeCode: { type: 'string', maxLength: 40 },
												at: { type: 'string', format: 'date-time', description: 'RFC 3339 with an offset.' },
												direction: { enum: ['in', 'out'] }
											}
										}
									}
								}
							}
						}
					}
				},
				responses: {
					'200': {
						description: 'What was stored.',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										accepted: { type: 'integer' },
										duplicates: { type: 'integer' },
										rejected: { type: 'integer' },
										flagged: { type: 'integer' },
										results: {
											type: 'array',
											description: 'One entry per punch sent, in the same order.',
											items: {
												type: 'object',
												required: ['index', 'status'],
												properties: {
													index: { type: 'integer' },
													status: { enum: ['accepted', 'duplicate', 'rejected'] },
													flagged: { type: 'boolean', description: 'Accepted into a month whose payroll is approved.' },
													reason: { enum: ['invalid', 'unknown_user', 'too_old', 'in_future', 'not_employed'] },
													message: { type: 'string' }
												}
											}
										}
									}
								}
							}
						}
					},
					'400': { $ref: '#/components/responses/problem' },
					'401': { $ref: '#/components/responses/problem' },
					'413': { $ref: '#/components/responses/problem' },
					'415': { $ref: '#/components/responses/problem' },
					'429': { $ref: '#/components/responses/problem' }
				}
			}
		},
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
