import { testEnv } from '../env';

export const E2E_PORT = 4173;
export const E2E_URL = `http://localhost:${E2E_PORT}`;

export const e2eEnv = testEnv('hrms_e2e', {
	PORT: String(E2E_PORT),
	ORIGIN: E2E_URL,
	APP_URL: E2E_URL,
	NODE_ENV: 'development',
	RL_LOGIN_PER_IP_PER_MIN: '1000',
	RL_RESET_PER_IP_HOUR: '1000',
	RL_INVITE_PER_IP_HOUR: '1000'
});
