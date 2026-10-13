export interface ConfigIssue {
  /** Dotted path to the offending value (e.g. `aliases.fast.candidates[1]`); empty for root-level issues. */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: readonly ConfigIssue[]) {
    super("");
    this.name = "ConfigError";
    this.source = source;
    this.issues = issues;
    this.message = formatConfigError(this);
  }
}

export function formatConfigError(error: ConfigError): string {
  const lines = error.issues.map((issue) =>
    issue.path ? `  - ${issue.path}: ${issue.message}` : `  - ${issue.message}`,
  );
  return [`Invalid configuration in ${error.source}:`, ...lines].join("\n");
}
