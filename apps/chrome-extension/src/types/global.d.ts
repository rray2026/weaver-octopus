// Compile-time constants injected by vite (see vite.config.ts).

/** True when the build was produced with `WEAVER_DEV=1`. Code paths gated
 *  on this constant are dead-code-eliminated by Rollup in production
 *  builds (where it's false). */
declare const __WEAVER_DEV__: boolean;

/** True when the build was produced with `WEAVER_RPC=1`. Enables the
 *  production command-poller (command queue only — no auto-reload, no log
 *  forwarding). Dead-code-eliminated in plain production builds. */
declare const __WEAVER_RPC__: boolean;
