// Side-effect module: import it first in every Hub entry point, before anything that captures settings.
import { assertNoRetiredEnvironment } from './retired.ts';

assertNoRetiredEnvironment(process.env);
