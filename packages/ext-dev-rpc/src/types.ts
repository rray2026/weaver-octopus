// Shared types across the package.

export interface DevCommand {
  action: string;
  [key: string]: unknown;
}

/** Returned to the dev-log-server (which echoes it into the log file).
 *  Anything serialisable. Returning undefined is treated as "ok, no detail". */
export type DevCommandResult = unknown;

/** A handler executes a queued command on the background SW side.
 *  `cmd.action` already matches the registered key — handlers may rely on
 *  the additional fields being shaped as expected, or do their own validation. */
export type DevCommandHandler = (cmd: DevCommand) => Promise<DevCommandResult> | DevCommandResult;

export interface DevServerEndpoints {
  /** Override the localhost dev-log-server URL. Default `http://127.0.0.1:9876`. */
  serverUrl?: string;
}
