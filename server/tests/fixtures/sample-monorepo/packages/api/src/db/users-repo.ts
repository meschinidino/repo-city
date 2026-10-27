import { formatMoney } from "@fixture/shared";

const db = {
  query: (_sql: string): string[] => ["ada"],
};

export async function listUsers(): Promise<string[]> {
  return db.query("SELECT name FROM users");
}

export function balanceLabel(cents: number): string {
  return formatMoney(cents);
}
