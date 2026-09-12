type Replacement = (match: string, ...groups: string[]) => string;

const patterns: readonly (readonly [RegExp, Replacement])[] = [
  [/\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|CERT)[A-Z0-9_]*=(\S+)/g,
    match => `${match.split('=')[0]}=<REDACTED>`],
  [/\b(?:sk|pk|xox[bapors]?|ghp|gho|ghu|ghs|ghr|github_pat|glpat|sk-ant|sk-proj|AIza|ya29|AKIA|ASIA|dop_v1|npm_[A-Za-z0-9])[A-Za-z0-9_-]{8,}\b/g,
    () => '<REDACTED>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9_.~+/-]{8,}={0,2}/g, (_match, scheme) => `${scheme} <REDACTED>`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => '<REDACTED PRIVATE KEY>'],
  [/("(?:api_?key|access_?token|refresh_?token|id_?token|secret|password|private_?key|client_?secret)"\s*:\s*")[^"]+(")/gi,
    (_match, prefix, suffix) => `${prefix}<REDACTED>${suffix}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, (_match, scheme) => `${scheme}<REDACTED>@`],
];

export const redactSecrets = (text: string): string =>
  patterns.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);

export const containsSecretShape = (text: string): boolean => redactSecrets(text) !== text;
