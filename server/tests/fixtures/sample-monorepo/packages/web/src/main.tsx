import { UserCard } from "./components/UserCard";
import { formatName } from "@fixture/shared";

export function main(): string {
  return `${formatName("Grace", "Hopper")}:${UserCard.name}`;
}
