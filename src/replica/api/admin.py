from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from replica.db.database import engine

router = APIRouter()


@router.get("/admin/tables")
async def list_tables():
    """List all tables in the database with row counts."""
    async with engine.connect() as conn:
        result = await conn.execute(
            text("""
                SELECT schemaname, tablename
                FROM pg_tables
                WHERE schemaname = 'public'
                ORDER BY tablename
            """)
        )
        tables = result.fetchall()

        table_info = []
        for row in tables:
            table_name = row[1]
            count_result = await conn.execute(text(f'SELECT COUNT(*) FROM "{table_name}"'))  # noqa: S608
            count = count_result.scalar()
            table_info.append({"name": table_name, "row_count": count})

    return {"tables": table_info}


@router.get("/admin/tables/{table_name}")
async def get_table_data(
    table_name: str,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """Get paginated data from a specific table with column metadata."""
    async with engine.connect() as conn:
        check = await conn.execute(
            text("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = :name"),
            {"name": table_name},
        )
        if not check.fetchone():
            raise HTTPException(404, f"Table '{table_name}' not found")

        col_result = await conn.execute(
            text("""
                SELECT column_name, data_type, udt_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = :name
                ORDER BY ordinal_position
            """),
            {"name": table_name},
        )
        columns = [{"name": r[0], "data_type": r[1], "udt_name": r[2]} for r in col_result.fetchall()]

        count_result = await conn.execute(text(f'SELECT COUNT(*) FROM "{table_name}"'))  # noqa: S608
        total = count_result.scalar()

        vector_cols = {c["name"] for c in columns if c["udt_name"] == "vector"}

        select_parts = []
        for c in columns:
            col_name = c["name"]
            if col_name in vector_cols:
                select_parts.append(
                    f'LEFT("{col_name}"::text, 60) || '
                    f"CASE WHEN LENGTH(\"{col_name}\"::text) > 60 THEN '...[dim=' || vector_dims(\"{col_name}\") || ']' ELSE '' END "
                    f'AS "{col_name}"'
                )
            else:
                select_parts.append(f'"{col_name}"')

        select_sql = ", ".join(select_parts)
        query = text(f'SELECT {select_sql} FROM "{table_name}" ORDER BY 1 DESC LIMIT :limit OFFSET :offset')  # noqa: S608
        data_result = await conn.execute(query, {"limit": limit, "offset": offset})

        rows = [dict(zip([c["name"] for c in columns], row)) for row in data_result.fetchall()]

        for row in rows:
            for key, val in row.items():
                if hasattr(val, "isoformat"):
                    row[key] = val.isoformat()
                elif not isinstance(val, (str, int, float, bool, type(None), list, dict)):
                    row[key] = str(val)

    return {
        "table_name": table_name,
        "columns": columns,
        "rows": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
    }
