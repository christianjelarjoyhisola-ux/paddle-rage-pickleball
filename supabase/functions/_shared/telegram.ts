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
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
      return { chatId, ok: true };
    } catch (error) {
      console.error("Telegram delivery failed", {
        recipient: chatId.slice(-4).padStart(chatId.length, "*"),
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { chatId, ok: false };
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
  };
}
