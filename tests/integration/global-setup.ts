import { prepareDatabase, testEnv } from '../env';

export default async function setup(): Promise<void> {
	await prepareDatabase(testEnv('hrms_test'));
}
