/**
 * タスクの終端状態（これ以上作業しない状態）の単一の真実の源。
 *
 * Issue #7: 'abandoned'（取り下げ）は 'done' と同じく終端状態であり、統合ブランチへ積まれる
 * 途中の変更を持たない。従来は merge.ts の SQL と publish.ts の TypeScript 判定が別々に
 * `status != 'done'` だけで「未完了」を判定しており、abandoned のタスクが残っていると
 * ticket_ready が出ず reconcile もチケットを閉じない不具合があった。
 *
 * ここで終端状態の配列を 1 箇所に定義し、TypeScript の判定ヘルパーと SQL 断片の両方を
 * この配列から導出することで、二重定義を避ける。
 *
 * これらの値は src/db/schema.sql の CHECK (status IN ('open','in_progress','done','abandoned','blocked'))、
 * src/index.ts の z.enum、src/lockage/claim.ts の Task.status ユニオン型と整合している。
 */

/**
 * 終端状態（これ以上作業が進まない状態）の一覧。単一の真実の源。
 */
export const TERMINAL_TASK_STATUSES = ['done', 'abandoned'] as const;

export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/**
 * 与えられた status が終端状態（'done' または 'abandoned'）かどうかを返す。
 * TaskView2.status などが string 型であるため、引数は string を受け取る。
 */
export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * 終端状態の SQL IN 句のリテラル部分（例 "('done','abandoned')"）を生成する。
 *
 * 注意: ここで連結する値は TERMINAL_TASK_STATUSES のハードコードされた定数リテラルのみであり、
 * ユーザー入力は一切含まれない。したがって SQL インジェクションの懸念はない。
 * （SQL 側に 'done' / 'abandoned' を直接書かず、必ずこの関数から導出することで二重定義を防ぐ。）
 */
function terminalStatusValueList(): string {
  return `(${TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(',')})`;
}

/**
 * `status IN ('done','abandoned')` に相当する SQL 断片を返す。
 * column 省略時は 'status' を対象にする。
 */
export function terminalStatusInClause(column = 'status'): string {
  return `${column} IN ${terminalStatusValueList()}`;
}

/**
 * `status NOT IN ('done','abandoned')`（＝終端状態でない＝未完了）に相当する SQL 断片を返す。
 * column 省略時は 'status' を対象にする。
 */
export function terminalStatusNotInClause(column = 'status'): string {
  return `${column} NOT IN ${terminalStatusValueList()}`;
}
