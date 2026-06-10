import type { User } from "./types";

export interface UserCardProps {
  user: User;
  onSelect(id: string): void;
}

export type UserId = string;

export class UserCardModel {
  title: string;

  constructor(title: string) {
    this.title = title;
  }

  render(props: UserCardProps): string {
    return `${this.title}: ${props.user.name}`;
  }
}

export function formatUser(user: User): string {
  return user.name;
}
