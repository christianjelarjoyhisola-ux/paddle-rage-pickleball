// Server-only Telegram delivery helpers. Bot credentials and recipient IDs
// must never be accepted from browser payloads.

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

export function telegramChatIds(): string[] {
  return [...new Set(
    clean(Deno.env.get("TELEGRAM_CHAT_ID"))
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )];
}

export function telegramConfigured(): boolean {
  return Boolean(clean(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500)) &&
    telegramChatIds().length > 0;
}

export async function sendTelegramHtml(
  message: string,
  recipients = telegramChatIds(),
): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  sent: number;
  failed: number;
  deliveredChatIds: string[];
  failedChatIds: string[];
  errors: string[];
}> {
  const botToken = clean(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500);
  const chatIds = [...new Set(recipients.map((id) => clean(id, 200)).filter(Boolean))];
  if (!botToken || !chatIds.length) {
    return {
      ok: true,
      skipped: true,
      reason: "Telegram not configured",
      sent: 0,
      failed: 0,
      deliveredChatIds: [],
      failedChatIds: [],
      errors: ["Telegram is not configured"],
    };
  }

  const results = await Promise.all(chatIds.map(async (chatId) => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
      if (!response.ok) {
        let detail = `Telegram HTTP ${response.status}`;
        try {
          const payload = await response.json() as { description?: unknown };
          const description = clean(payload?.description, 160);
          if (description) detail += `: ${description}`;
        } catch (_) {
          // Keep the status-only diagnostic when Telegram returns no JSON body.
        }
        throw new Error(detail);
      }
      return { chatId, ok: true, error: "" };
    } catch (error) {
      console.error("Telegram delivery failed", {
        recipient: chatId.slice(-4).padStart(chatId.length, "*"),
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        chatId,
        ok: false,
        error: error instanceof Error ? clean(error.message, 200) : "Unknown Telegram error",
      };
    }
  }));

  const deliveredChatIds = results.filter((result) => result.ok).map((result) => result.chatId);
  const failedChatIds = results.filter((result) => !result.ok).map((result) => result.chatId);
  return {
    ok: failedChatIds.length === 0,
    sent: deliveredChatIds.length,
    failed: failedChatIds.length,
    deliveredChatIds,
    failedChatIds,
    errors: results.filter((result) => !result.ok).map((result) => result.error),
  };
}
