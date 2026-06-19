/**
 * Exposes the build-time-injected semantic version string for spec-check.
 *
 * Used by the CLI for --version output and report metadata.
 * Exports: `SPEC_CHECK_VERSION`.
 */
declare const __SPEC_CHECK_VERSION__: string;

/**
 * The semantic version string of the spec-check package, injected at build time.
 *
 * @remarks
 * This value is substituted by the bundler from the `__SPEC_CHECK_VERSION__` global.
 * It is undefined at runtime only if the build pipeline failed to inject it.
 */
export const SPEC_CHECK_VERSION = __SPEC_CHECK_VERSION__;
