CREATE VIRTUAL TABLE wiki_fts USING fts5(
  space_key UNINDEXED,
  version UNINDEXED,
  page_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);
