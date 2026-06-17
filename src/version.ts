declare const __SPEC_CHECK_VERSION__: string;

/**
 * The semantic version string of the spec-check package, injected at build time.
 *
 * @remarks
 * This value is substituted by the bundler from the `__SPEC_CHECK_VERSION__` global.
 * It is undefined at runtime only if the build pipeline failed to inject it.
 */
export const SPEC_CHECK_VERSION = __SPEC_CHECK_VERSION__;
