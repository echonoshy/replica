"""rename_ended_at_to_last_extraction_at

Rename sessions.ended_at to sessions.last_extraction_at to better reflect
that sessions can continue after extraction.

Revision ID: 70291a72832b
Revises: f509baaeb1b9
Create Date: 2026-04-05 10:11:02.258333
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '70291a72832b'
down_revision: Union[str, None] = '60a8400fe0ae'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename ended_at to last_extraction_at
    op.alter_column('sessions', 'ended_at', new_column_name='last_extraction_at')


def downgrade() -> None:
    # Rename back to ended_at
    op.alter_column('sessions', 'last_extraction_at', new_column_name='ended_at')
