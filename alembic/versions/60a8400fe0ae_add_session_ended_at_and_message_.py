"""add_session_ended_at_and_message_extraction_status

Revision ID: 60a8400fe0ae
Revises: a1b2c3d4e5f6
Create Date: 2026-04-04 09:06:31.419824
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "60a8400fe0ae"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create extraction_status enum type
    extraction_status_enum = postgresql.ENUM("pending", "extracted", "skipped", name="extraction_status")
    extraction_status_enum.create(op.get_bind(), checkfirst=True)

    # Add ended_at column to sessions table
    op.add_column("sessions", sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True))

    # Add extraction_status column to messages table
    op.add_column(
        "messages",
        sa.Column(
            "extraction_status",
            postgresql.ENUM("pending", "extracted", "skipped", name="extraction_status"),
            nullable=False,
            server_default="pending",
        ),
    )


def downgrade() -> None:
    # Remove extraction_status column from messages table
    op.drop_column("messages", "extraction_status")

    # Remove ended_at column from sessions table
    op.drop_column("sessions", "ended_at")

    # Drop extraction_status enum type
    extraction_status_enum = postgresql.ENUM("pending", "extracted", "skipped", name="extraction_status")
    extraction_status_enum.drop(op.get_bind(), checkfirst=True)
