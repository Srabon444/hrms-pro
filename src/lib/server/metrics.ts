import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
	name: 'hrms_http_request_duration_seconds',
	help: 'HTTP request duration',
	labelNames: ['method', 'route', 'status'],
	buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	registers: [registry]
});

export const rateLimited = new Counter({
	name: 'hrms_rate_limited_total',
	help: 'Requests rejected by a rate limiter',
	labelNames: ['bucket'],
	registers: [registry]
});

export const searchProviderFailures = new Counter({
	name: 'hrms_search_provider_failures_total',
	help: 'Global search providers that failed or ran out of time',
	labelNames: ['kind', 'reason'],
	registers: [registry]
});

export const lifecycleStepFailures = new Counter({
	name: 'hrms_lifecycle_step_failures_total',
	help: 'Hourly lifecycle steps that threw',
	labelNames: ['step'],
	registers: [registry]
});
