// Convenience re-exports. For best ESM tree-shaking, prefer importing
// from one of the narrower entry points:
//   - "@weaver-octopus/ext-dev-rpc/background"
//   - "@weaver-octopus/ext-dev-rpc/popup"
//   - "@weaver-octopus/ext-dev-rpc/content"
//   - "@weaver-octopus/ext-dev-rpc/vite"

export type {
  DevCommand,
  DevCommandHandler,
  DevCommandResult,
  DevServerEndpoints,
} from './types.js';
