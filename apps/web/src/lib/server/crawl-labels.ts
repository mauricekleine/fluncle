import { type Client } from "@libsql/client";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { getDb, typedRows } from "./db";

export type CrawlLabelScopeRow = {
  founding_date: null | string;
  id: string;
  mb_label_id: null | string;
  name: string;
  seed_state: string;
  slug: string;
};

const CRAWL_LABEL_LOOKUP_CHUNK_SIZE = 100;
const CRAWL_LABEL_DECISION_COLUMNS =
  "id, name, slug, mb_label_id, seed_state, founding_date, rowid as label_rowid";

export async function readCrawlLabelRows(
  column: "id" | "mb_label_id",
  values: readonly string[],
  client?: Pick<Client, "execute">,
): Promise<CrawlLabelScopeRow[]> {
  const keys = [...new Set(values)];
  const rows: (CrawlLabelScopeRow & { label_rowid: number })[] = [];
  if (keys.length === 0) {
    return rows;
  }
  const db = client ?? (await getDb());
  for (let offset = 0; offset < keys.length; offset += CRAWL_LABEL_LOOKUP_CHUNK_SIZE) {
    const chunk = keys.slice(offset, offset + CRAWL_LABEL_LOOKUP_CHUNK_SIZE);
    const result = await db.execute({
      args: chunk,
      sql: `select ${CRAWL_LABEL_DECISION_COLUMNS} from labels where ${column} in (${chunk.map(() => "?").join(", ")})${column === "id" ? " order by rowid" : ""}`,
    });
    rows.push(...typedRows<CrawlLabelScopeRow & { label_rowid: number }>(result.rows));
  }
  return column === "id" ? rows.sort((left, right) => left.label_rowid - right.label_rowid) : rows;
}

export async function readCrawlFoldLabelRows(
  keys: readonly string[],
  client?: Pick<Client, "execute">,
): Promise<CrawlLabelScopeRow[]> {
  const wanted = new Set(keys.filter(Boolean));
  if (wanted.size === 0) {
    return [];
  }
  const db = client ?? (await getDb());
  const result = await db.execute({
    args: [JSON.stringify([...wanted])],
    sql: `select ${CRAWL_LABEL_DECISION_COLUMNS} from labels
          where name_fold in (select value from json_each(?))
          union all
          select ${CRAWL_LABEL_DECISION_COLUMNS} from labels where name_fold is null
          order by label_rowid`,
  });
  return typedRows<CrawlLabelScopeRow>(result.rows).filter((row) =>
    wanted.has(labelFold(row.name)),
  );
}
