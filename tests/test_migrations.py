"""Exercise the quick-start migration chain in isolated PostgreSQL schemas."""

import io
import uuid

import asyncpg
import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.engine import make_url

from replica.config import get_settings
from replica.db.database import Base


def migration_sql(action, revisions):
    output = io.StringIO()
    action(Config("alembic.ini", output_buffer=output), revisions, sql=True)
    return output.getvalue()


@pytest.fixture
async def migration_db():
    url = make_url(get_settings().database_url).set(drivername="postgresql")
    db = await asyncpg.connect(url.render_as_string(hide_password=False))
    schema = f"migration_test_{uuid.uuid4().hex}"
    try:
        await db.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await db.execute(f"CREATE SCHEMA {schema}")
        await db.execute(f"SET search_path = {schema}, public")
        yield db
    finally:
        # A failed migration can leave the connection inside an aborted transaction.
        if db.is_in_transaction():
            await db.execute("ROLLBACK")
        await db.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        await db.close()


async def test_clean_install_and_migration_round_trip(migration_db):
    upgrade = migration_sql(command.upgrade, "head")
    await migration_db.execute(upgrade)
    await migration_db.execute(migration_sql(command.downgrade, "head:base"))
    await migration_db.execute(upgrade)

    head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
    assert await migration_db.fetchval("SELECT version_num FROM alembic_version") == head
    tables = await migration_db.fetch("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")
    assert {row["tablename"] for row in tables} == {"alembic_version", *Base.metadata.tables}


@pytest.mark.parametrize(
    ("revision", "table", "seed"),
    [
        (
            "7c95e7f38baa",
            "memory_notes",
            """
            INSERT INTO users (id, external_id) VALUES (gen_random_uuid(), 'legacy');
            INSERT INTO memory_notes (id, user_id, note_type, content, source)
            SELECT gen_random_uuid(), id, 'evergreen', 'legacy memory', 'manual' FROM users;
            """,
        ),
        (
            "0b5e0e1353d2",
            "conversation_metas",
            "INSERT INTO conversation_metas (id, name) VALUES (gen_random_uuid(), 'legacy')",
        ),
        (
            "0b5e0e1353d2",
            "memcells",
            "INSERT INTO memcells (id, group_id, timestamp, data_type) VALUES (gen_random_uuid(), 'group', now(), 'Conversation')",
        ),
        (
            "0b5e0e1353d2",
            "user_profiles",
            """
            INSERT INTO user_profiles (id, user_id, group_id, scenario, profile_data, version, is_latest, confidence, memcell_count)
            VALUES (gen_random_uuid(), 'legacy', '', 'group_chat', '{}', 1, true, 1, 1);
            """,
        ),
        (
            "70291a72832b",
            "sessions",
            """
            INSERT INTO users (id, external_id) VALUES (gen_random_uuid(), 'legacy');
            INSERT INTO sessions (id, user_id, status, token_count, compaction_count, last_extraction_at)
            SELECT gen_random_uuid(), id, 'active', 0, 0, now() FROM users;
            """,
        ),
    ],
)
async def test_upgrade_preserves_unmapped_legacy_rows(migration_db, revision, table, seed):
    await migration_db.execute(migration_sql(command.upgrade, revision))
    await migration_db.execute(seed)
    before = await migration_db.fetch(f"SELECT * FROM {table}")
    with pytest.raises(asyncpg.RaiseError, match=f"legacy data in {table}"):
        await migration_db.execute(migration_sql(command.upgrade, f"{revision}:head"))
    await migration_db.execute("ROLLBACK")
    assert await migration_db.fetchval("SELECT version_num FROM alembic_version") == revision
    assert await migration_db.fetch(f"SELECT * FROM {table}") == before


async def test_upgrade_keeps_legacy_user_and_session(migration_db):
    await migration_db.execute(migration_sql(command.upgrade, "7c95e7f38baa"))
    user_id = await migration_db.fetchval("""
        INSERT INTO users (id, external_id) VALUES (gen_random_uuid(), 'existing') RETURNING id
    """)
    session_id = await migration_db.fetchval(
        """
        INSERT INTO sessions (id, user_id, status, token_count, compaction_count)
        VALUES (gen_random_uuid(), $1, 'active', 37, 0) RETURNING id
    """,
        user_id,
    )
    await migration_db.execute(migration_sql(command.upgrade, "7c95e7f38baa:head"))
    row = await migration_db.fetchrow(
        """
        SELECT external_id, status, token_count FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.id = $1
    """,
        session_id,
    )
    assert tuple(row) == ("existing", "active", 37)
