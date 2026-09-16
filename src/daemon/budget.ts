import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { privateDatabaseFiles, privateDirectorySync } from '../storage/private-files.ts';

export type BudgetLimits = Readonly<{ maxCallsPerDay: number; maxTokensPerDay: number }>;
export type BudgetTicket = Readonly<{ day: string; estimatedInput: number; estimatedOutput: number }>;

const dayAt = (at: number): string => new Date(at).toISOString().slice(0, 10);
const integer = (value: number): number => Math.max(0, Math.trunc(value));

export class GlobalBudgetLedger {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(home: string) {
    const root = join(home, 'shared', 'memory', 'daemon');
    privateDirectorySync(root);
    this.path = join(root, 'budget.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS daily_budget (
        day TEXT PRIMARY KEY,
        calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      );
    `);
    privateDatabaseFiles(this.path);
  }

  reserve(limits: BudgetLimits, estimate: Readonly<{ inputTokens: number; outputTokens: number }>, at = Date.now()): BudgetTicket | undefined {
    const day = dayAt(at);
    const input = integer(estimate.inputTokens);
    const output = integer(estimate.outputTokens);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT calls,input_tokens,output_tokens FROM daily_budget WHERE day=?').get(day) as
        { calls?: number; input_tokens?: number; output_tokens?: number } | undefined;
      const calls = Number(row?.calls ?? 0);
      const tokens = Number(row?.input_tokens ?? 0) + Number(row?.output_tokens ?? 0);
      if (calls >= limits.maxCallsPerDay || tokens + input + output > limits.maxTokensPerDay) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      this.db.prepare(`INSERT INTO daily_budget(day,calls,input_tokens,output_tokens) VALUES (?,1,?,?)
        ON CONFLICT(day) DO UPDATE SET calls=calls+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens`)
        .run(day, input, output);
      this.db.exec('COMMIT');
      return { day, estimatedInput: input, estimatedOutput: output };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reconcile(ticket: BudgetTicket, actual: Readonly<{ inputTokens: number; outputTokens: number }>): void {
    const input = integer(actual.inputTokens);
    const output = integer(actual.outputTokens);
    this.db.prepare(`UPDATE daily_budget SET
      input_tokens=max(0,input_tokens+?),output_tokens=max(0,output_tokens+?) WHERE day=?`)
      .run(input - ticket.estimatedInput, output - ticket.estimatedOutput, ticket.day);
  }

  usage(at = Date.now()): Readonly<{ day: string; calls: number; inputTokens: number; outputTokens: number }> {
    const day = dayAt(at);
    const row = this.db.prepare('SELECT calls,input_tokens,output_tokens FROM daily_budget WHERE day=?').get(day) as
      { calls?: number; input_tokens?: number; output_tokens?: number } | undefined;
    return { day, calls: Number(row?.calls ?? 0), inputTokens: Number(row?.input_tokens ?? 0), outputTokens: Number(row?.output_tokens ?? 0) };
  }

  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    privateDatabaseFiles(this.path);
    this.db.close();
  }
}
