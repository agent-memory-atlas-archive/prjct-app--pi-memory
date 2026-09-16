type Replacement = (match: string, ...groups: string[]) => string;

const MAX_REDACTION_CHARS = 2 * 1024 * 1024;
const SECRET_KEY = /(?:^|[_-])(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|private[_-]?key|client[_-]?secret|account[_-]?key|cert)(?:$|[_-])/iu;
const secretKey = (key: string): boolean => SECRET_KEY.test(key)
  || /(?:password|passwd|secret|token|apikey|accesskey|credential|authorization|privatekey|clientsecret|accountkey|cert)$/iu.test(key.replaceAll(/[_.-]/gu, ''));

const ordinaryPatterns: readonly (readonly [RegExp, Replacement])[] = [
  [/(\bAuthorization\s*:\s*)(?:(?:Bearer|Basic|token)\s+)?\S+/giu, (_match, prefix) => `${prefix}<REDACTED>`],
  [/("(?:api_?key|token|access_?token|refresh_?token|id_?token|secret|password|private_?key|client_?secret|authorization)"\s*:\s*)(?:"[^"]*"|'[^']*'|[^,}\s]+)/giu,
    (_match, prefix) => `${prefix}"<REDACTED>"`],
  [/\b([A-Za-z][A-Za-z0-9_.-]{0,63})(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
    (match, key, separator) => secretKey(key) ? `${key}${separator}<REDACTED>` : match],
  [/\b(?:sk[-_]|pk[-_]|xox[bapors]?[-_]|gh[pousr][-_]|github_pat_|glpat-|sk-ant-|sk-proj-|hf_|rk_live_|whsec_|npm_)[A-Za-z0-9_-]{8,}\b/giu,
    () => '<REDACTED>'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu, () => '<REDACTED>'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu, () => '<REDACTED JWT>'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9_.~+/-]{8,}={0,2}/giu, (_match, scheme) => `${scheme} <REDACTED>`],
  [/([?&](?:access_?token|refresh_?token|api_?key|client_?secret)=)[^&#\s]+/giu, (_match, prefix) => `${prefix}<REDACTED>`],
  [/(\bcurl\b[^\r\n]{0,256}\s-(?:u|-user)\s+)(?:"[^"]*"|'[^']*'|\S+)/giu, (_match, prefix) => `${prefix}<REDACTED>`],
];

const redactPrivateBlocks = (text: string): string => {
  const starts = [...text.matchAll(/-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----/gu)];
  const state = starts.reduce<{ cursor: number; parts: string[] }>((result, match) => {
    const start = match.index ?? -1;
    if (start < result.cursor) return result;
    const endMarker = text.indexOf('-----END ', start + match[0].length);
    const endLine = endMarker < 0 ? text.length : text.indexOf('-----', endMarker + '-----END '.length);
    const end = endLine < 0 ? text.length : endLine + 5;
    return { cursor: end, parts: [...result.parts, text.slice(result.cursor, start), '<REDACTED PRIVATE KEY>'] };
  }, { cursor: 0, parts: [] });
  return starts.length ? [...state.parts, text.slice(state.cursor)].join('') : text;
};

const redactUrlUserInfo = (text: string): string => text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s]+)/giu, (match, scheme, rest) => {
  const at = String(rest).lastIndexOf('@');
  if (at < 1 || !String(rest).slice(0, at).includes(':')) return match;
  return `${scheme}<REDACTED>@${String(rest).slice(at + 1)}`;
});

export const redactSecrets = (input: string): string => {
  const bounded = input.length <= MAX_REDACTION_CHARS ? input : `${input.slice(0, MAX_REDACTION_CHARS)}\n[REDACTION INPUT TRUNCATED]`;
  const blocks = redactPrivateBlocks(bounded);
  const urls = redactUrlUserInfo(blocks);
  return ordinaryPatterns.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), urls);
};

export const containsSecretShape = (text: string): boolean => redactSecrets(text) !== text;
