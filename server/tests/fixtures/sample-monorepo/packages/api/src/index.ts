import { usersRouter } from "./routes/users";
import { formatName } from "@fixture/shared";
import "./broken";

export function bootstrap(): string {
  return `${formatName("Ada", "Lovelace")}:${usersRouter}`;
}
