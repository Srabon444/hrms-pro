import { z } from 'zod';

const bool = z
	.string()
	.optional()
	.transform((v) => v === '1' || v === 'true');

const int = (fallback: number) =>
	z
		.string()
		.optional()
		.transform((v) => (v ? Number.parseInt(v, 10) : fallback))
		.pipe(z.number().int().positive());

const schema = z
	.object({
		NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
		DATABASE_URL: z.string().url(),
		AUTH_DATABASE_URL: z.string().url(),
		OWNER_DATABASE_URL: z.string().url().optional(),
		DB_POOL_MAX: int(10),
		REDIS_URL: z.string().url(),
		REDIS_PREFIX: z.string().min(1).default('hrms'),
		S3_ENDPOINT: z.string().url(),
		S3_REGION: z.string().default('us-east-1'),
		S3_ACCESS_KEY: z.string().min(1),
		S3_SECRET_KEY: z.string().min(1),
		S3_BUCKET: z.string().min(3),
		SMTP_URL: z.string().min(1),
		MAIL_FROM: z.string().min(3),
		APP_URL: z.string().url(),
		APP_ENC_KEYS: z.string().min(10),
		METRICS_TOKEN: z.string().min(8),
		LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
		TEST_MODE: bool,
		GOOGLE_CLIENT_ID: z.string().optional(),
		GOOGLE_CLIENT_SECRET: z.string().optional(),
		RL_LOGIN_PER_IP_PER_MIN: int(20),
		RL_LOGIN_PER_EMAIL_IP_15MIN: int(5),
		RL_RESET_PER_EMAIL_HOUR: int(3),
		RL_RESET_PER_IP_HOUR: int(10),
		RL_INVITE_PER_IP_HOUR: int(10),
		RL_MUTATIONS_PER_USER_MIN: int(120),
		RL_DOWNLOADS_PER_USER_MIN: int(60),
		TOTP_FAILS_PER_15MIN: int(10)
	})
	.refine((c) => !(c.TEST_MODE && c.NODE_ENV === 'production'), {
		message: 'TEST_MODE must never be enabled with NODE_ENV=production'
	});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
	if (cached) return cached;
	const parsed = schema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid environment configuration: ${issues}`);
	}
	cached = parsed.data;
	return cached;
}
