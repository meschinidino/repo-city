import { listUsers } from "../db/users-repo";
import { formatName } from "@fixture/shared";

export const usersRouter = "users-router";

export async function GET(): Promise<string> {
  const users = await listUsers();
  return users.map((u) => formatName(u, "")).join(",");
}
