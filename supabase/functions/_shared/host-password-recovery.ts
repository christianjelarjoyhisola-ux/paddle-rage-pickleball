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
    html: `<div style="font-family:Arial,sans-serif;color:#152019;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
      <h1 style="font-size:26px;line-height:1.2;">Reset your host password</h1>
      <p>You requested a password reset for your Paddle Rage host account. Tap the button below to choose a new password.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td bgcolor="#B6F000" style="border-radius:8px;text-align:center;">
        <a href="${escapedLink}" target="_blank" style="display:inline-block;padding:16px 28px;border:1px solid #B6F000;border-radius:8px;background-color:#B6F000;color:#0B0F0C;font-size:18px;font-weight:bold;text-decoration:none;">Reset Password</a>
      </td></tr></table>
      <p>If the button doesn’t work, <a href="${escapedLink}" target="_blank" style="color:#174c72;text-decoration:underline;">open the password reset page here</a>.</p>
      <p>This secure link expires and can only be used once. Open it in Safari or Chrome. If you did not request this, ignore this email. Your password has not changed.</p>
    </div>`,
    plain: `Reset your Paddle Rage host password\n\nChoose a new password: ${link}\n\nThis secure link expires and can only be used once. Open it in Safari or Chrome. If you did not request this, ignore this email. Your password has not changed.`,
    tags: { type: "host_password_recovery" },
  });
}
