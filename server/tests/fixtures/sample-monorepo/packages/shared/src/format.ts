export function formatName(first: string, last: string): string {
  return `${first} ${last}`.trim();
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
