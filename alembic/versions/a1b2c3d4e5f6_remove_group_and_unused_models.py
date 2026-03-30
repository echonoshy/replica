"""remove_group_and_unused_models

Drop unused tables (group_profiles, conversation_metas, conversation_statuses,
cluster_states, entities, relationships, behavior_histories), remove group_id
columns from active tables, remove session_status.archived enum value.

Revision ID: a1b2c3d4e5f6
Revises: 0b5e0e1353d2
Create Date: 2026-03-30 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, ARRAY, UUID


revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "0b5e0e1353d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Drop unused tables
    op.drop_table("behavior_histories")
    op.drop_table("cluster_states")
    op.drop_table("conversation_statuses")
    op.drop_table("conversation_metas")
    op.drop_table("relationships")
    op.drop_table("entities")
    op.drop_table("group_profiles")

    # 2. memcells: drop group_id column and its indexes
    op.drop_index("ix_memcells_group_deleted_ts", table_name="memcells")
    op.drop_index("ix_memcells_group_id", table_name="memcells")
    op.drop_column("memcells", "group_id")

    # 3. knowledge_entries: drop group_id column and its index
    op.drop_index("ix_knowledge_entries_group_id", table_name="knowledge_entries")
    op.drop_column("knowledge_entries", "group_id")

    # 4. user_profiles: drop group_id, scenario; rebuild constraints
    op.drop_constraint("uq_user_profile_version", "user_profiles", type_="unique")
    op.drop_index("ix_user_profile_latest", table_name="user_profiles")
    op.drop_index("ix_user_profiles_group_id", table_name="user_profiles")
    op.drop_column("user_profiles", "group_id")
    op.drop_column("user_profiles", "scenario")
    op.create_unique_constraint("uq_user_profile_version", "user_profiles", ["user_id", "version"])
    op.create_index("ix_user_profile_latest", "user_profiles", ["user_id", "is_latest"])

    # 5. Remove 'archived' from session_status enum
    op.execute("UPDATE sessions SET status = 'deleted' WHERE status = 'archived'")
    op.execute("ALTER TYPE session_status RENAME TO session_status_old")
    op.execute("CREATE TYPE session_status AS ENUM ('active', 'deleted')")
    op.execute(
        "ALTER TABLE sessions ALTER COLUMN status TYPE session_status "
        "USING status::text::session_status"
    )
    op.execute("DROP TYPE session_status_old")


def downgrade() -> None:
    # 5. Restore 'archived' to session_status enum
    op.execute("ALTER TYPE session_status RENAME TO session_status_old")
    op.execute("CREATE TYPE session_status AS ENUM ('active', 'archived', 'deleted')")
    op.execute(
        "ALTER TABLE sessions ALTER COLUMN status TYPE session_status "
        "USING status::text::session_status"
    )
    op.execute("DROP TYPE session_status_old")

    # 4. Restore user_profiles columns and constraints
    op.drop_index("ix_user_profile_latest", table_name="user_profiles")
    op.drop_constraint("uq_user_profile_version", "user_profiles", type_="unique")
    op.add_column("user_profiles", sa.Column("scenario", sa.String(50), server_default="assistant"))
    op.add_column("user_profiles", sa.Column("group_id", sa.String(255), server_default=""))
    op.create_index("ix_user_profiles_group_id", "user_profiles", ["group_id"])
    op.create_index("ix_user_profile_latest", "user_profiles", ["user_id", "group_id", "is_latest"])
    op.create_unique_constraint("uq_user_profile_version", "user_profiles", ["user_id", "group_id", "version"])

    # 3. Restore knowledge_entries.group_id
    op.add_column("knowledge_entries", sa.Column("group_id", sa.String(255), nullable=True))
    op.create_index("ix_knowledge_entries_group_id", "knowledge_entries", ["group_id"])

    # 2. Restore memcells.group_id
    op.add_column("memcells", sa.Column("group_id", sa.String(255), nullable=True))
    op.create_index("ix_memcells_group_id", "memcells", ["group_id"])
    op.create_index("ix_memcells_group_deleted_ts", "memcells", ["group_id", "deleted_at", "timestamp"])

    # 1. Recreate dropped tables
    op.create_table(
        "group_profiles",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("group_id", sa.String(255), nullable=False),
        sa.Column("group_name", sa.String(255), nullable=True),
        sa.Column("topics", JSONB, nullable=True),
        sa.Column("roles", JSONB, nullable=True),
        sa.Column("summary", sa.Text, nullable=True),
        sa.Column("subject", sa.Text, nullable=True),
        sa.Column("version", sa.Integer, server_default="1"),
        sa.Column("is_latest", sa.Boolean, server_default="true"),
        sa.Column("extend", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("group_id", "version", name="uq_group_profile_version"),
    )
    op.create_index("ix_group_profile_latest", "group_profiles", ["group_id", "is_latest"])

    op.create_table(
        "entities",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, index=True),
        sa.Column("entity_type", sa.String(100), nullable=True),
        sa.Column("aliases", ARRAY(sa.String(255)), nullable=True),
        sa.Column("extend", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "relationships",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("source_entity_id", sa.String(255), nullable=False, index=True),
        sa.Column("target_entity_id", sa.String(255), nullable=False, index=True),
        sa.Column("relationship", JSONB, nullable=True),
        sa.Column("extend", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("source_entity_id", "target_entity_id", name="uq_relationship_pair"),
    )

    op.create_table(
        "conversation_metas",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("group_id", sa.String(255), nullable=True),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("scene", sa.String(100), nullable=True),
        sa.Column("scene_desc", JSONB, nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("default_timezone", sa.String(50), nullable=True),
        sa.Column("conversation_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_details", JSONB, nullable=True),
        sa.Column("tags", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_conv_meta_group", "conversation_metas", ["group_id"], unique=True)

    op.create_table(
        "conversation_statuses",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("group_id", sa.String(255), nullable=False),
        sa.Column("old_msg_start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("new_msg_start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_memcell_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_conv_status_group", "conversation_statuses", ["group_id"], unique=True)

    op.create_table(
        "cluster_states",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("group_id", sa.String(255), nullable=False),
        sa.Column("event_ids", JSONB, nullable=True),
        sa.Column("timestamps", JSONB, nullable=True),
        sa.Column("cluster_ids", JSONB, nullable=True),
        sa.Column("eventid_to_cluster", JSONB, nullable=True),
        sa.Column("next_cluster_idx", sa.Integer, server_default="0"),
        sa.Column("cluster_centroids", JSONB, nullable=True),
        sa.Column("cluster_counts", JSONB, nullable=True),
        sa.Column("cluster_last_ts", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_cluster_state_group", "cluster_states", ["group_id"], unique=True)

    op.create_table(
        "behavior_histories",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.String(255), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=True),
        sa.Column("behavior_type", ARRAY(sa.String(255)), nullable=True),
        sa.Column("event_id", sa.String(255), nullable=True),
        sa.Column("meta", JSONB, nullable=True),
        sa.Column("extend", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_behavior_user_type_ts", "behavior_histories", ["user_id", "timestamp"])
