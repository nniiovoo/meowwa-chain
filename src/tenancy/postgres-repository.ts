/**
 * The narrow Postgres seam the published chain rails depend on.
 *
 * In the private application this module is the tenant data layer, and it carries a great deal
 * that has nothing to do with money. The rails in this repository only ever needed three things
 * from it: a result shape, a client and a pool. Declaring them here rather than publishing the
 * repository keeps the dependency to what it actually is -- a driver contract -- and lets these
 * files be read, typechecked and tested without the rest of the product.
 *
 * The shapes are structurally compatible with `pg`, so a real `Pool` satisfies `PgPoolLike`
 * without an adapter, as does any test double that answers `query` and `release`.
 */

export interface PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}
