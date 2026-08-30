export type BalanceNoticeClaimInput = {
  bookingKey: string;
  bookingRef: string;
  eventType: string;
  recipientEmail: string;
  force?: boolean;
  leaseSeconds?: number;
};

export type AcquiredBalanceNoticeClaim = {
  acquired: true;
  id: string;
  claimToken: string;
  attemptCount: number;
  leaseExpiresAt: string;
};

export type RejectedBalanceNoticeClaim = {
  acquired: false;
  id: string | null;
  reason:
    | "already_sent"
    | "lease_active"
    | "balance_pending_review"
    | "balance_already_paid"
    | "booking_not_payable"
    | "not_claimed";
  leaseExpiresAt: string | null;
};

export type BalanceNoticeClaim =
  | AcquiredBalanceNoticeClaim
  | RejectedBalanceNoticeClaim;

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

export async function claimBalanceNotification(
  db: RpcClient,
  input: BalanceNoticeClaimInput,
): Promise<BalanceNoticeClaim> {
  const { data, error } = await db.rpc("claim_booking_balance_notification", {
    p_booking_key: input.bookingKey,
    p_booking_ref: input.bookingRef,
    p_event_type: input.eventType,
    p_recipient_email: input.recipientEmail,
    p_force: input.force === true,
    p_lease_seconds: Math.max(
      60,
      Math.min(Number(input.leaseSeconds || 300), 900),
    ),
  });
  if (error) {
    throw new Error(error.message || "Unable to claim balance notification");
  }

  const result = objectValue(data);
  if (result.acquired === true) {
    const id = nullableString(result.id);
    const claimToken = nullableString(result.claimToken);
    const leaseExpiresAt = nullableString(result.leaseExpiresAt);
    if (!id || !claimToken || !leaseExpiresAt) {
      throw new Error("Balance notification claim response is incomplete");
    }
    return {
      acquired: true,
      id,
      claimToken,
      attemptCount: Math.max(1, Number(result.attemptCount || 1)),
      leaseExpiresAt,
    };
  }

  const reason =
    result.reason === "already_sent" ||
      result.reason === "lease_active" ||
      result.reason === "balance_pending_review" ||
      result.reason === "balance_already_paid" ||
      result.reason === "booking_not_payable"
      ? result.reason
      : "not_claimed";
  return {
    acquired: false,
    id: nullableString(result.id),
    reason,
    leaseExpiresAt: nullableString(result.leaseExpiresAt),
  };
}

export async function finishBalanceNotification(
  db: RpcClient,
  input: {
    id: string;
    claimToken: string;
    outcome: "sent" | "failed";
    providerMessageId?: string | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await db.rpc("finish_booking_balance_notification", {
    p_notification_id: input.id,
    p_claim_token: input.claimToken,
    p_outcome: input.outcome,
    p_provider_message_id: input.providerMessageId || null,
    p_error_message: input.errorMessage?.slice(0, 2000) || null,
  });
  if (error) {
    throw new Error(error.message || "Unable to finish balance notification");
  }
  if (typeof data !== "boolean") {
    throw new Error("Balance notification completion response is invalid");
  }
  return data;
}
