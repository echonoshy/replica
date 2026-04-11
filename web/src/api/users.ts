import client from "./client";

export interface User {
  id: string;
  external_id: string;
  name: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export function getUsers() {
  return client.get<User[]>("/v1/users");
}

export function createUser(data: {
  external_id: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  return client.post<User>("/v1/users", data);
}

export function getUser(userId: string) {
  return client.get<User>(`/v1/users/${userId}`);
}

export function deleteUser(userId: string) {
  return client.delete(`/v1/users/${userId}`);
}
