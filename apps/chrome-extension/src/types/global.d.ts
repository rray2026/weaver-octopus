// Compile-time constants injected by vite (see vite.config.ts).

/** True when the build was produced with `WEAVER_DEV=1`. Code paths gated
 *  on this constant are dead-code-eliminated by Rollup in production
 *  builds (where it's false). */
declare const __WEAVER_DEV__: boolean;
