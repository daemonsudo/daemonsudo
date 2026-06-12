// Minimal ambient typing so tsc (Node typings only) can compile the
// bun:sqlite branch; at runtime Bun provides the real module.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean });
    exec(sql: string): void;
    query(sql: string): {
      run(...params: never[]): unknown;
      get(...params: never[]): unknown;
      all(...params: never[]): unknown[];
    };
    close(): void;
  }
}
