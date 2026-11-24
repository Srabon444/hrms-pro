import { prepareDatabase } from '../env';
import { e2eEnv } from './env';

await prepareDatabase(e2eEnv);
