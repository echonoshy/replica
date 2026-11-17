"""Checks for legacy rows that have no automatic conversion in a migration."""

from alembic import op


def require_no_legacy_rows(table: str, condition: str = "TRUE") -> None:
    # Both expressions are fixed by the migration. Hold the lock until its DDL commits.
    op.execute(f"LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE")
    op.execute(f"""
        DO $check$
        BEGIN
            IF EXISTS (SELECT 1 FROM {table} WHERE {condition}) THEN
                RAISE EXCEPTION 'Migration would discard legacy data in {table}'
                    USING HINT = 'See the legacy database upgrade instructions in the README.';
            END IF;
        END
        $check$
    """)
