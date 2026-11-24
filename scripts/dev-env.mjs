import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env') && !process.argv.includes('--force')) {
	console.error('.env already exists; pass --force to overwrite');
	process.exit(1);
}

const secrets = {
	app_pw: randomBytes(18).toString('hex'),
	auth_pw: randomBytes(18).toString('hex'),
	owner_pw: randomBytes(18).toString('hex'),
	minio_pw: randomBytes(18).toString('hex'),
	enc_key: randomBytes(32).toString('base64'),
	metrics_token: randomBytes(24).toString('hex')
};

const out = readFileSync('.env.example', 'utf8').replace(/<([a-z_]+)>/g, (m, k) => secrets[k] ?? m);
writeFileSync('.env', out, { mode: 0o600 });
console.error('.env written with fresh local secrets');
