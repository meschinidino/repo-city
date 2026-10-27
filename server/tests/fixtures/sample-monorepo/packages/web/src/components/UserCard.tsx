import { formatName } from "@fixture/shared";

export function UserCard(props: { first: string; last: string }) {
  return <div>{formatName(props.first, props.last)}</div>;
}
