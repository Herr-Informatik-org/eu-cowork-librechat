interface UserWithPassword {
  password?: string;
}

/** Synthetic cost-10 bcrypt hash; it never authorizes an account. */
const DUMMY_PASSWORD_HASH = '$2a$10$iV/Miupwby8SbMXjclypVOeCcyJvfSnxDywGnsXgmmfGiKzytMMkm';

export interface ComparePasswordDeps {
  compare: (candidatePassword: string, hash: string) => Promise<boolean>;
}

/** Performs hash work for missing credentials without allowing the dummy to authenticate. */
export async function comparePassword(
  user: UserWithPassword | null | undefined,
  candidatePassword: string,
  deps: ComparePasswordDeps,
): Promise<boolean> {
  const passwordHash = user?.password;
  const matched = await deps.compare(candidatePassword, passwordHash || DUMMY_PASSWORD_HASH);
  return !!passwordHash && matched;
}
