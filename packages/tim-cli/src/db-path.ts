import * as os from 'os';
import * as path from 'path';
import { loadConfig, type TimConfigFile } from 'tim-core';

export function getDbPath(config?: TimConfigFile): string {
  const resolved = config ?? loadConfig();
  return process.env.TIM_DB_PATH || resolved.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
