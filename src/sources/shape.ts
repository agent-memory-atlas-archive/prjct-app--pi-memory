/**
 * Reading arbitrary records without knowing their shape.
 *
 * A sibling library publishes JSON in whatever form suits it, and that form
 * changes. Nothing here names a field of prjct's or pi-team's: callers describe
 * where to look with paths and rules, and when they describe nothing the values
 * are detected from the record itself. Adding a new source should be a mapping,
 * not a new module.
 */

export type FieldPath = string;
export type JsonValue = unknown;
export type JsonRecord = Readonly<Record<string, JsonValue>>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads `a.b.c` and `a.0.b`. A `*` segment fans out across an array or the
 * values of an object, so `observations.*.id` collects every id.
 */
export const valuesAt = (source: unknown, path: FieldPath): JsonValue[] => {
  const segments = path.split('.').filter(Boolean);
  return segments.reduce<JsonValue[]>((current, segment) => current.flatMap(value => {
    if (value === undefined || value === null) return [];
    if (segment === '*') return Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    if (Array.isArray(value)) {
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0 && index < value.length ? [value[index]] : [];
    }
    return isRecord(value) && segment in value ? [value[segment]] : [];
  }), [source]).filter(value => value !== undefined && value !== null);
};

export const valueAt = (source: unknown, path: FieldPath): JsonValue | undefined => valuesAt(source, path)[0];

/** First path that yields a non-empty string. */
export const firstText = (source: unknown, paths: readonly FieldPath[]): string | undefined => {
  for (const path of paths) {
    const value = valuesAt(source, path).find(candidate => typeof candidate === 'string' && candidate.trim().length > 0);
    if (typeof value === 'string') return value;
  }
  return undefined;
};

/** Accepts an ISO string, epoch milliseconds, or epoch seconds. */
export const asTimestamp = (value: JsonValue): string | undefined => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const millis = Math.abs(value) < 1e11 ? value * 1000 : value;
  return Number.isFinite(new Date(millis).getTime()) ? new Date(millis).toISOString() : undefined;
};

export const firstTimestamp = (source: unknown, paths: readonly FieldPath[]): string | undefined => {
  for (const path of paths) {
    for (const candidate of valuesAt(source, path)) {
      const stamp = asTimestamp(candidate);
      if (stamp) return stamp;
    }
  }
  return undefined;
};

/**
 * One condition over a record. Every field is optional and all supplied ones
 * must hold, so `{ field: 'x' }` means "x is present" and adding `equals`
 * narrows it. Rules are data: they can come from a config file.
 */
export type FieldRule = Readonly<{
  field: FieldPath;
  equals?: JsonValue;
  oneOf?: readonly JsonValue[];
  matches?: string;
  exists?: boolean;
  absent?: boolean;
  gt?: number;
  lt?: number;
}>;

export const matchesRule = (record: unknown, rule: FieldRule): boolean => {
  const values = valuesAt(record, rule.field);
  if (rule.absent === true) return values.length === 0;
  if (values.length === 0) return false;
  if (rule.exists === true && Object.keys(rule).length === 2) return true;
  return values.some(value => {
    if (rule.equals !== undefined && value !== rule.equals) return false;
    if (rule.oneOf !== undefined && !rule.oneOf.includes(value)) return false;
    if (rule.matches !== undefined && !(typeof value === 'string' && new RegExp(rule.matches, 'u').test(value))) return false;
    if (rule.gt !== undefined && !(typeof value === 'number' && value > rule.gt)) return false;
    if (rule.lt !== undefined && !(typeof value === 'number' && value < rule.lt)) return false;
    return true;
  });
};

/** `keep` is a disjunction, `drop` a veto applied after it. */
export type SelectionRules = Readonly<{ keep?: readonly FieldRule[]; drop?: readonly FieldRule[] }>;

export const selects = (record: unknown, rules: SelectionRules): boolean => {
  if (rules.drop?.some(rule => matchesRule(record, rule))) return false;
  return !rules.keep?.length || rules.keep.some(rule => matchesRule(record, rule));
};

// Detection order: the earlier a name appears, the more likely it is the one
// meant. These are conventions across JSON records generally, not any one
// library's schema, and every one of them can be overridden by a mapping.
export const ID_HINTS: readonly FieldPath[] = ['id', 'uuid', 'key', 'externalId', 'external_id', 'rootId', 'root_id', 'broadcastId', 'artifactId', 'sha', 'hash'];
export const TEXT_HINTS: readonly FieldPath[] = ['text', 'summary', 'body', 'content', 'message', 'description', 'statement', 'detail', 'output'];
export const TITLE_HINTS: readonly FieldPath[] = ['title', 'subject', 'name', 'label', 'heading'];
export const TIME_HINTS: readonly FieldPath[] = ['recordedAt', 'observedAt', 'createdAt', 'updatedAt', 'timestamp', 'at', 'time', 'date', 'closed', 'opened'];
export const KIND_HINTS: readonly FieldPath[] = ['kind', 'type', 'category', 'intent'];

/** Declared paths first, then the conventional ones not already named. */
export const paths = (declared: readonly FieldPath[] | undefined, hints: readonly FieldPath[]): readonly FieldPath[] =>
  [...(declared ?? []), ...hints.filter(hint => !declared?.includes(hint))];
