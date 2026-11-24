ALTER TABLE documents ADD first_published_version integer;
--> statement-breakpoint
UPDATE documents
SET first_published_version = (
  SELECT min(s.version)
  FROM snapshots AS s, json_each(s.manifest_json, '$.documents') AS source
  WHERE s.space_key = documents.space_key AND source.value = documents.doc_id
);
