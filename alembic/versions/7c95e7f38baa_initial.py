"""Create the legacy schema required by the unified-memory migration.

The original 7c95e7f38baa revision was stamped after creating tables from the
ORM. This snapshot reflects those models before revision f509baaeb1b9.
"""

import sqlalchemy as sa
from alembic import context, op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision = "7c95e7f38baa"
down_revision = None
branch_labels = None
depends_on = None


# Foreign-key order for removing the legacy schema.
LEGACY_TABLES = (
    "memory_chunks",
    "messages",
    "memory_notes",
    "sessions",
    "users",
    "user_profiles",
    "relationships",
    "memcells",
    "group_profiles",
    "foresight_records",
    "event_log_records",
    "episodic_memories",
    "entities",
    "conversation_statuses",
    "conversation_metas",
    "cluster_states",
    "behavior_histories",
)


def upgrade() -> None:
    # Unversioned installations may already have the legacy schema.
    if not context.is_offline_mode():
        tables = set(sa.inspect(op.get_bind()).get_table_names())
        missing = set(LEGACY_TABLES) - tables
        if not missing:
            return
        if len(missing) != len(LEGACY_TABLES):
            raise RuntimeError(f"Incomplete unversioned Replica schema. Missing tables: {sorted(missing)}")

    op.create_table(
        "behavior_histories",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("behavior_type", postgresql.ARRAY(sa.String(length=100)), nullable=True),
        sa.Column("event_id", sa.String(length=255), nullable=True),
        sa.Column("meta", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_behavior_histories_event_id"), "behavior_histories", ["event_id"], unique=False)
    op.create_index(op.f("ix_behavior_histories_user_id"), "behavior_histories", ["user_id"], unique=False)
    op.create_index("ix_behavior_user_type_ts", "behavior_histories", ["user_id", "timestamp"], unique=False)
    op.create_table(
        "cluster_states",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.String(length=255), nullable=False),
        sa.Column("event_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("timestamps", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cluster_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("eventid_to_cluster", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("next_cluster_idx", sa.Integer(), nullable=False),
        sa.Column("cluster_centroids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cluster_counts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cluster_last_ts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cluster_state_group", "cluster_states", ["group_id"], unique=True)
    op.create_table(
        "conversation_metas",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.String(length=255), nullable=True),
        sa.Column("name", sa.String(length=500), nullable=True),
        sa.Column("scene", sa.String(length=100), nullable=True),
        sa.Column("scene_desc", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("description", sa.String(length=2000), nullable=True),
        sa.Column("default_timezone", sa.String(length=100), nullable=True),
        sa.Column("conversation_created_at", sa.String(length=100), nullable=True),
        sa.Column("user_details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_conv_meta_group", "conversation_metas", ["group_id"], unique=True)
    op.create_table(
        "conversation_statuses",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.String(length=255), nullable=False),
        sa.Column("old_msg_start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("new_msg_start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_memcell_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_conv_status_group", "conversation_statuses", ["group_id"], unique=True)
    op.create_table(
        "entities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=500), nullable=False),
        sa.Column("entity_type", sa.String(length=100), nullable=False),
        sa.Column("aliases", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_entities_name"), "entities", ["name"], unique=False)
    op.create_table(
        "episodic_memories",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=True),
        sa.Column("user_name", sa.String(length=255), nullable=True),
        sa.Column("group_id", sa.String(length=255), nullable=True),
        sa.Column("group_name", sa.String(length=255), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("participants", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("episode", sa.Text(), nullable=False),
        sa.Column("keywords", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("linked_entities", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("memcell_event_id_list", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("parent_type", sa.String(length=50), nullable=True),
        sa.Column("parent_id", sa.String(length=255), nullable=True),
        sa.Column("embedding", Vector(dim=2560), nullable=True),
        sa.Column("vector_model", sa.String(length=255), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_episodic_group_ts", "episodic_memories", ["group_id", "timestamp"], unique=False)
    op.create_index(
        "ix_episodic_group_user_ts", "episodic_memories", ["group_id", "user_id", "timestamp"], unique=False
    )
    op.create_index(op.f("ix_episodic_memories_group_id"), "episodic_memories", ["group_id"], unique=False)
    op.create_index(op.f("ix_episodic_memories_user_id"), "episodic_memories", ["user_id"], unique=False)
    op.create_index("ix_episodic_parent", "episodic_memories", ["parent_id"], unique=False)
    op.create_index("ix_episodic_user_ts", "episodic_memories", ["user_id", "timestamp"], unique=False)
    op.create_table(
        "event_log_records",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=True),
        sa.Column("user_name", sa.String(length=255), nullable=True),
        sa.Column("group_id", sa.String(length=255), nullable=True),
        sa.Column("group_name", sa.String(length=255), nullable=True),
        sa.Column("atomic_fact", sa.Text(), nullable=False),
        sa.Column("parent_type", sa.String(length=50), nullable=False),
        sa.Column("parent_id", sa.String(length=255), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("participants", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("event_type", sa.String(length=50), nullable=True),
        sa.Column("embedding", Vector(dim=2560), nullable=True),
        sa.Column("vector_model", sa.String(length=255), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_event_log_records_group_id"), "event_log_records", ["group_id"], unique=False)
    op.create_index(op.f("ix_event_log_records_user_id"), "event_log_records", ["user_id"], unique=False)
    op.create_index("ix_eventlog_group_ts", "event_log_records", ["group_id", "timestamp"], unique=False)
    op.create_index("ix_eventlog_parent", "event_log_records", ["parent_id"], unique=False)
    op.create_index("ix_eventlog_user_ts", "event_log_records", ["user_id", "timestamp"], unique=False)
    op.create_table(
        "foresight_records",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=True),
        sa.Column("user_name", sa.String(length=255), nullable=True),
        sa.Column("group_id", sa.String(length=255), nullable=True),
        sa.Column("group_name", sa.String(length=255), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("parent_type", sa.String(length=50), nullable=False),
        sa.Column("parent_id", sa.String(length=255), nullable=False),
        sa.Column("start_time", sa.String(length=20), nullable=True),
        sa.Column("end_time", sa.String(length=20), nullable=True),
        sa.Column("duration_days", sa.Integer(), nullable=True),
        sa.Column("participants", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("embedding", Vector(dim=2560), nullable=True),
        sa.Column("vector_model", sa.String(length=255), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_foresight_group_ts", "foresight_records", ["group_id", "start_time", "end_time"], unique=False)
    op.create_index("ix_foresight_parent", "foresight_records", ["parent_id"], unique=False)
    op.create_index(op.f("ix_foresight_records_group_id"), "foresight_records", ["group_id"], unique=False)
    op.create_index(op.f("ix_foresight_records_user_id"), "foresight_records", ["user_id"], unique=False)
    op.create_index("ix_foresight_user_ts", "foresight_records", ["user_id", "start_time", "end_time"], unique=False)
    op.create_table(
        "group_profiles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.String(length=255), nullable=False),
        sa.Column("group_name", sa.String(length=255), nullable=True),
        sa.Column("topics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("roles", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("summary", sa.String(length=1000), nullable=True),
        sa.Column("subject", sa.String(length=500), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("is_latest", sa.Boolean(), nullable=False),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id", "version", name="uq_group_profile_version"),
    )
    op.create_index("ix_group_profile_latest", "group_profiles", ["group_id", "is_latest"], unique=False)
    op.create_index(op.f("ix_group_profiles_group_id"), "group_profiles", ["group_id"], unique=False)
    op.create_table(
        "memcells",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=True),
        sa.Column("group_id", sa.String(length=255), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("subject", sa.Text(), nullable=True),
        sa.Column("data_type", sa.String(length=50), nullable=False),
        sa.Column("original_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("participants", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("keywords", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("linked_entities", postgresql.ARRAY(sa.String(length=255)), nullable=True),
        sa.Column("episode", sa.Text(), nullable=True),
        sa.Column("event_log", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("foresight_memories", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_memcells_group_deleted_ts", "memcells", ["group_id", "deleted_at", "timestamp"], unique=False)
    op.create_index(op.f("ix_memcells_group_id"), "memcells", ["group_id"], unique=False)
    op.create_index("ix_memcells_user_deleted_ts", "memcells", ["user_id", "deleted_at", "timestamp"], unique=False)
    op.create_index(op.f("ix_memcells_user_id"), "memcells", ["user_id"], unique=False)
    op.create_table(
        "relationships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("source_entity_id", sa.String(length=255), nullable=False),
        sa.Column("target_entity_id", sa.String(length=255), nullable=False),
        sa.Column("relationship", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("extend", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_entity_id", "target_entity_id", name="uq_relationship_pair"),
    )
    op.create_index(op.f("ix_relationships_source_entity_id"), "relationships", ["source_entity_id"], unique=False)
    op.create_index(op.f("ix_relationships_target_entity_id"), "relationships", ["target_entity_id"], unique=False)
    op.create_table(
        "user_profiles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("user_name", sa.String(length=255), nullable=True),
        sa.Column("group_id", sa.String(length=255), nullable=False),
        sa.Column("scenario", sa.String(length=50), nullable=False),
        sa.Column("profile_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("is_latest", sa.Boolean(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("memcell_count", sa.Integer(), nullable=False),
        sa.Column("cluster_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_updated_cluster", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "group_id", "version", name="uq_user_profile_version"),
    )
    op.create_index("ix_user_profile_latest", "user_profiles", ["user_id", "group_id", "is_latest"], unique=False)
    op.create_index(op.f("ix_user_profiles_group_id"), "user_profiles", ["group_id"], unique=False)
    op.create_index(op.f("ix_user_profiles_user_id"), "user_profiles", ["user_id"], unique=False)
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_users_external_id"), "users", ["external_id"], unique=True)
    op.create_table(
        "sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("status", postgresql.ENUM("active", "archived", "deleted", name="session_status"), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("compaction_count", sa.Integer(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_sessions_user_id"), "sessions", ["user_id"], unique=False)
    op.create_table(
        "memory_notes",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=True),
        sa.Column("note_type", postgresql.ENUM("daily", "evergreen", name="note_type"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "source",
            postgresql.ENUM("auto_flush", "session_end", "manual", "compaction", name="note_source"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_memory_notes_user_created", "memory_notes", ["user_id", "created_at"], unique=False)
    op.create_index("ix_memory_notes_user_type", "memory_notes", ["user_id", "note_type"], unique=False)
    op.create_table(
        "messages",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("parent_id", sa.UUID(), nullable=True),
        sa.Column("role", postgresql.ENUM("user", "assistant", "system", "tool", name="message_role"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column(
            "message_type",
            postgresql.ENUM("message", "compaction_summary", "memory_flush", name="message_type"),
            nullable=False,
        ),
        sa.Column("is_compacted", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["messages.id"],
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_messages_session_created", "messages", ["session_id", "created_at"], unique=False)
    op.create_table(
        "memory_chunks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("note_id", sa.UUID(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(dim=2560), nullable=True),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["note_id"],
            ["memory_notes.id"],
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_memory_chunks_user_created", "memory_chunks", ["user_id", "created_at"], unique=False)
    op.create_index(op.f("ix_memory_chunks_user_id"), "memory_chunks", ["user_id"], unique=False)


def downgrade() -> None:
    for table in LEGACY_TABLES:
        op.drop_table(table)
    op.execute("DROP TYPE message_role")
    op.execute("DROP TYPE message_type")
    op.execute("DROP TYPE note_source")
    op.execute("DROP TYPE note_type")
    op.execute("DROP TYPE session_status")
