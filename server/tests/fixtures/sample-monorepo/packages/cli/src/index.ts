import { formatMoney } from "@fixture/shared";
import { listUsers } from "../../api/src/db/users-repo";

export async function run(): Promise<string> {
  const users = await listUsers();
  return `${users.length}:${formatMoney(100)}`;
}
