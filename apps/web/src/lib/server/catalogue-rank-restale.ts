type RestaleStatement = { args: string[]; sql: string };

const RESTALE_CHUNK = 200;

export function restaleCatalogueRankStatements(trackIds: readonly string[]): RestaleStatement[] {
  const unique = [...new Set(trackIds)];

  if (unique.length === 0) {
    return [];
  }

  const statements: RestaleStatement[] = [];

  for (let i = 0; i < unique.length; i += RESTALE_CHUNK) {
    const chunk = unique.slice(i, i + RESTALE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");

    statements.push({
      args: chunk,
      sql: `update tracks set catalogue_rank_corpus = null
            where track_id in (${placeholders})`,
    });
  }

  return statements;
}

export function restaleCatalogueRankByLabelStatement(labelId: string): RestaleStatement {
  return {
    args: [labelId],
    sql: `update tracks set catalogue_rank_corpus = null
          where label_id = ?`,
  };
}
