/** Programmatic API of the `contextscope` CLI (used by tests and embedders). */
export {
  loadConfig,
  maskConfig,
  ConfigError,
  CONFIG_FILE_NAME,
  DEMO_DATA_DIR,
  ENV_VARS,
  MIN_AUTH_TOKEN_LENGTH,
} from './config.js';
export type { ConfigFlags, ConfigSource, LoadConfigOptions, LoadedConfig } from './config.js';
export { buildProgram, runCli, CliExit, CLI_VERSION } from './commands.js';
export type { ProgramOptions, ServerDeps } from './commands.js';
export type { CliIO } from './output.js';
export {
  readPidFile,
  writePidFile,
  removePidFile,
  pidFilePath,
  getStatus,
  stopServer,
  isAlive,
  checkHealth,
} from './pid.js';
export type { PidInfo, StatusResult, StopResult } from './pid.js';
export { runDoctorChecks, nodeVersionOk } from './doctor.js';
export type { CheckResult } from './doctor.js';
