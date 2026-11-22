import pino from 'pino';

export const log = pino({
	level: process.env.LOG_LEVEL ?? 'info',
	base: { service: process.env.HRMS_SERVICE ?? 'app' },
	redact: {
		paths: ['password', '*.password', 'token', '*.token', 'headers.cookie', 'headers.authorization'],
		censor: '***'
	}
});
