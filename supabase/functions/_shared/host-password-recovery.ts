// deno-lint-ignore-file no-explicit-any
import { sendMailerooEmail } from "./maileroo.ts";

export const HOST_RECOVERY_MESSAGE = "If this email belongs to an active host account, a reset link will arrive shortly.";

export async function requestHostPasswordRecovery(
  db: any,
  email: string,
  appUrl: string,
  send = sendMailerooEmail,
) {
  const { data: account, error } = await db.from("accounts")
    .select("id, email").eq("email", email).eq("role", "host")
    .eq("status", "active").maybeSingle();
  if (error) throw new Error("Host recovery account lookup failed");
  if (!account) return;
  const { data: authData, error: authError } = await db.auth.admin.getUserById(account.id);
  if (authError) throw new Error("Host recovery identity lookup failed");
  const user = authData?.user;
  if (!user || String(user.email || "").toLowerCase() !== email || !user.email_confirmed_at || user.deleted_at || (user.banned_until && Date.parse(user.banned_until) > Date.now())) return;
  const { data: claimed, error: claimError } = await db.rpc("claim_host_password_recovery", { p_account_id: account.id });
  if (claimError) throw new Error("Host recovery rate limit unavailable");
  if (!claimed) return;
  const redirectTo = `${appUrl.replace(/\/+$/, "")}/host.html?recovery=1`;
  const { data, error: linkError } = await db.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
  const link = data?.properties?.action_link;
  if (linkError || !link || data?.user?.id !== account.id) throw new Error("Host recovery link unavailable");
  const escapedLink = String(link).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await send({
    to: email,
    subject: "Reset your Paddle Rage host password",
    html: `<h1>Reset your host password</h1><p>You requested a password reset for your Paddle Rage host account.</p><p><a href="${escapedLink}">Choose a new password</a></p><p>This secure link expires and can only be used once. Open it in Safari or Chrome. If you did not request this, ignore this email. Your password has not changed.</p>`,
    plain: `Reset your Paddle Rage host password\n\nChoose a new password: ${link}\n\nThis secure link expires and can only be used once. Open it in Safari or Chrome. If you did not request this, ignore this email. Your password has not changed.`,
    tags: { type: "host_password_recovery" },
  });
}
