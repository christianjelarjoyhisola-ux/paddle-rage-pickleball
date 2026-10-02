// Authentication is isolated from both the service client and browser session.
export async function verifyHostReapplicationPassword(auth: any, email: string, password: string, expectedUserId: string): Promise<boolean> {
  const { data, error } = await auth.signInWithPassword({ email, password });
  try {
    return !error && Boolean(data?.user?.email_confirmed_at) &&
      data?.user?.id === expectedUserId && data.user.email?.toLowerCase() === email.toLowerCase();
  } finally {
    if (data?.session) await auth.signOut({ scope: "local" });
  }
}
