// The product's name, in one place. Code reads it from here, so a rename is
// a change to this file. (Prose in the README and docs is plain text.)
export const BRAND = {
  /** The product name, as people see it. */
  name: "Talqava Agents",
  /** The default name of the agent itself. */
  agentName: "Talqava",
  /** Lowercase, for package names, cookies and file names. */
  slug: "talqava",
  /** Prefix of every setting read from the environment, e.g. TALQAVA_PASSWORD. */
  envPrefix: "TALQAVA_",
} as const;

/** Reads a product setting from the environment, e.g. setting("PASSWORD") reads TALQAVA_PASSWORD. */
export function setting(key: string): string | undefined {
  return process.env[`${BRAND.envPrefix}${key}`];
}
