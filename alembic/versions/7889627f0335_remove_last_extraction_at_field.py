"""remove_last_extraction_at_field

Revision ID: 7889627f0335
Revises: 70291a72832b
Create Date: 2026-04-05 10:59:17.184604
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7889627f0335'
down_revision: Union[str, None] = '70291a72832b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Remove last_extraction_at field from sessions table
    op.drop_column('sessions', 'last_extraction_at')


def downgrade() -> None:
    # Restore last_extraction_at field
    op.add_column('sessions', sa.Column('last_extraction_at', sa.DateTime(timezone=True), nullable=True))
