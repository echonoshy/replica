import client from "./client";

export interface TableInfo {
  name: string;
  row_count: number;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  udt_name: string;
}

export interface TableDataResponse {
  table_name: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export function getTables() {
  return client.get<{ tables: TableInfo[] }>("/v1/admin/tables");
}

export interface TableFilter {
  field: string;
  op: "eq" | "contains" | "gt" | "lt" | "gte" | "lte";
  value: string;
}

export function getTableData(tableName: string, limit = 50, offset = 0, filter?: TableFilter) {
  const params: Record<string, string | number> = { limit, offset };
  if (filter) {
    params.filter_field = filter.field;
    params.filter_op = filter.op;
    params.filter_value = filter.value;
  }
  return client.get<TableDataResponse>(`/v1/admin/tables/${tableName}`, { params });
}
