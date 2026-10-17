declare const __PKG_VERSION__: string | undefined;
/** Package version, injected at build time; "dev" when running from source. */
export const VERSION: string = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "dev";
