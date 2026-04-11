import client from "./client";

export interface MemorizeRequest {
  new_raw_data_list: { role: string; content: string }[];
  history_raw_data_list?: { role: string; content: string }[];
  user_id_list?: string[];
  group_id?: string | null;
  group_name?: string | null;
  scene?: string;
}

export interface MemorizeResponse {
  memory_count: number;
  status: string;
}

export function memorize(data: MemorizeRequest) {
  return client.post<MemorizeResponse>("/v1/memories", data);
}
