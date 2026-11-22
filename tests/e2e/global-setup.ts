import { prepareDatabase } from '../env';
import { e2eEnv } from './env';

export default async function setup(): Promise<void> {
	await prepareDatabase(e2eEnv);
}
