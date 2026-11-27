import pino from 'pino';

export const LOG_REDACT = {
	paths: [
		'password',
		'*.password',
		'token',
		'*.token',
		'headers.cookie',
		'headers.authorization',
		'apiKey',
		'*.apiKey',
		'keyEnc',
		'*.keyEnc',
		'headers["x-goog-api-key"]',
		'headers["x-api-key"]'
	],
	censor: '***'
};

export const log = pino({
	level: process.env.LOG_LEVEL ?? 'info',
	base: { service: process.env.HRMS_SERVICE ?? 'app' },
	redact: LOG_REDACT
});
