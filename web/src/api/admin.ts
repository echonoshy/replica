import client from './client'

export interface TableInfo {
  name: string
  row_count: number
}

export interface ColumnInfo {
  name: string
  data_type: string
  udt_name: string
}

export interface TableDataResponse {
  table_name: string
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
}

export function getTables() {
  return client.get<{ tables: TableInfo[] }>('/v1/admin/tables')
}

export function getTableData(tableName: string, limit = 50, offset = 0) {
  return client.get<TableDataResponse>(`/v1/admin/tables/${tableName}`, {
    params: { limit, offset },
  })
}
