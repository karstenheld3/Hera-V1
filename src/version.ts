import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const BINARY_VERSION: string = pkg.version;
export const PRODUCT = "Hera";
export const PROTOCOL_VERSION = 1;
