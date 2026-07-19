const BRAND = {
  black: "#050706",
  surface: "#0b0f0c",
  surfaceRaised: "#111712",
  input: "#151d17",
  border: "#29362c",
  neon: "#b6f000",
  neonBright: "#d7ff3f",
  neonDark: "#82ad00",
  text: "#f6f8f2",
  muted: "#b7c0b5",
  danger: "#ff5a5f",
  warning: "#ffcc4d",
  neonTint: "#172006",
  dangerTint: "#241012",
  warningTint: "#211b08",
} as const;

export type ConfirmationPayload = {
  bookingRef: string;
  email: string;
  fullName: string;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  total: number;
  downpayment: number;
  hostBooking?: boolean;
  balanceDueAt?: string | null;
  remainingBalance?: number;
  contactNumber?: string;
  bookingItems?: Array<{
    courtName: string;
    date: string;
    startTime: string;
    endTime: string;
    duration: number;
    total: number;
    downpayment?: number;
  }>;
};

export type ReschedulePayload = {
  bookingRef: string;
  email: string;
  fullName: string;
  courtName: string;
  oldDate: string;
  oldStartTime: string;
  oldEndTime: string;
  newDate: string;
  newStartTime: string;
  newEndTime: string;
  newDuration: number;
  note?: string;
};

export type BookingCancellationPayload = {
  bookingRef: string;
  fullName: string;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
  total: number;
  paid: number;
  reason?: string;
  paymentRejected?: boolean;
};

export type BalanceNoticePayload = {
  eventType:
    | "reminder_3d"
    | "reminder_2d"
    | "reminder_1d"
    | "forfeited"
    | "manual";
  bookingRef: string;
  fullName: string;
  courtName: string;
  schedules: Array<{
    date: string;
    startTime: string;
    endTime: string;
  }>;
  paid: number;
  remainingBalance: number;
  deadline: string;
};

export type HostDecisionPayload = {
  fullName: string;
  status: "approved" | "rejected";
  reviewNote?: string;
};

type LayoutOptions = {
  preheader: string;
  status: string;
  statusBackground: string;
  statusColor: string;
  title: string;
  introHtml: string;
  bodyHtml: string;
  footerText: string;
};

export type HostVerificationPayload = {
  fullName: string;
  verificationUrl: string;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plain(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return plain(value);
  return date.toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatPhp(value: number): string {
  return `&#8369;${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function formatPhpPlain(value: number): string {
  return `PHP ${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

export function formatDeadline(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function publicUrl(): string {
  return (Deno.env.get("APP_PUBLIC_URL") || "https://paddleragecdo.ph").trim()
    .replace(/\/+$/, "");
}

function logoUrl(): string {
  return (Deno.env.get("PUBLIC_LOGO_URL") ||
    `${publicUrl()}/paddleragelogo.jpg`).trim();
}

function layout(options: LayoutOptions): string {
  const siteUrl = escapeHtml(publicUrl());
  const logo = escapeHtml(logoUrl());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(options.title)} | Paddle Rage Pickleball</title>
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
    table{border-collapse:separate}
    @media only screen and (max-width:620px){
      .email-wrap{padding:0!important}
      .email-card{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}
      .mobile-pad{padding-left:22px!important;padding-right:22px!important}
      .stack-cell{display:block!important;width:100%!important;box-sizing:border-box!important}
      .stack-gap{padding-top:12px!important}
      .brand-name{font-size:20px!important;letter-spacing:1.4px!important}
      .email-title{font-size:27px!important}
      .detail-table td{font-size:14px!important}
    }
  </style>
</head>
<body style="margin:0!important;padding:0!important;background:${BRAND.black};font-family:Arial,'Helvetica Neue',sans-serif;color:${BRAND.text};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${
    escapeHtml(options.preheader)
  }&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${BRAND.black};">
    <tr><td class="email-wrap" align="center" style="padding:30px 12px;">
      <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:18px;overflow:hidden;box-shadow:0 18px 54px rgba(0,0,0,.42);">
        <tr><td style="height:7px;background:${BRAND.neon};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" style="padding:25px 34px;background:${BRAND.black};border-bottom:1px solid ${BRAND.border};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="72" style="width:72px;vertical-align:middle;">
              <img src="${logo}" width="58" height="58" alt="Paddle Rage Pickleball" style="display:block;width:58px;height:58px;border-radius:13px;object-fit:contain;background:#ffffff;padding:3px;border:1px solid ${BRAND.neon};">
            </td>
            <td style="vertical-align:middle;">
              <div class="brand-name" style="font-size:22px;line-height:1.15;font-weight:900;letter-spacing:1.8px;color:#ffffff;">PADDLE RAGE</div>
              <div style="margin-top:3px;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:2.1px;color:${BRAND.neon};">PICKLEBALL</div>
              <div style="margin-top:5px;font-size:11px;line-height:1.3;color:${BRAND.muted};">Iponan, Cagayan de Oro</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:12px 20px;text-align:center;background:${options.statusBackground};color:${options.statusColor};font-size:13px;line-height:1.35;font-weight:900;letter-spacing:1.2px;">${
    escapeHtml(options.status)
  }</td></tr>
        <tr><td class="mobile-pad" style="padding:34px 38px 12px;background:${BRAND.surface};">
          <h1 class="email-title" style="margin:0 0 15px;font-size:31px;line-height:1.18;color:${BRAND.text};font-weight:900;letter-spacing:-.4px;">${
    escapeHtml(options.title)
  }</h1>
          <div style="font-size:16px;line-height:1.68;color:${BRAND.text};">${options.introHtml}</div>
        </td></tr>
        <tr><td class="mobile-pad" style="padding:12px 38px 34px;background:${BRAND.surface};">${options.bodyHtml}</td></tr>
        <tr><td class="mobile-pad" style="padding:22px 34px;background:${BRAND.black};border-top:1px solid ${BRAND.border};text-align:center;">
          <div style="font-size:13px;line-height:1.6;color:${BRAND.muted};">${
    escapeHtml(options.footerText)
  }</div>
          <div style="margin-top:12px;"><a href="${siteUrl}" style="color:${BRAND.neon};font-size:12px;font-weight:800;text-decoration:none;letter-spacing:.4px;">paddleragecdo.ph</a></div>
          <div style="margin-top:8px;font-size:11px;line-height:1.5;color:#879085;">Automated transactional email &middot; Paddle Rage Pickleball</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function getConfirmationItems(payload: ConfirmationPayload) {
  return Array.isArray(payload.bookingItems) && payload.bookingItems.length
    ? payload.bookingItems
    : [{
      courtName: payload.courtName,
      date: payload.date,
      startTime: payload.startTime,
      endTime: payload.endTime,
      duration: payload.duration,
      total: payload.total,
      downpayment: payload.downpayment,
    }];
}

export function renderHostVerificationEmail(
  payload: HostVerificationPayload,
): { html: string; plain: string } {
  const fullName = plain(payload.fullName) || "Host applicant";
  const verificationUrl = plain(payload.verificationUrl);
  const html = layout({
    preheader:
      "Verify your email to complete your Paddle Rage host application.",
    status: "HOST APPLICATION · EMAIL VERIFICATION",
    statusBackground: BRAND.neonTint,
    statusColor: BRAND.neon,
    title: "Verify your email address",
    introHtml: `Hi <strong>${
      escapeHtml(fullName)
    }</strong>, your Open Play host application has been received.`,
    bodyHtml: `
      <div style="padding:22px;border:1px solid ${BRAND.border};border-radius:14px;background:${BRAND.surfaceRaised};">
        <div style="font-size:15px;line-height:1.65;color:${BRAND.text};">Confirm that this email belongs to you before the court owner can activate a host dashboard login.</div>
        <div style="margin-top:22px;text-align:center;">
          <a href="${
      escapeHtml(verificationUrl)
    }" style="display:inline-block;padding:14px 24px;border-radius:10px;background:${BRAND.neon};color:${BRAND.black};font-size:15px;line-height:1.2;font-weight:900;text-decoration:none;">Verify email address</a>
        </div>
        <div style="margin-top:16px;font-size:13px;line-height:1.6;color:${BRAND.text};font-weight:800;">This one-use link expires in 1 hour.</div>
        <div style="margin-top:10px;font-size:12px;line-height:1.6;color:${BRAND.muted};word-break:break-all;">If the button does not open, copy this secure link into your browser:<br><a href="${
      escapeHtml(verificationUrl)
    }" style="color:${BRAND.neon};">${escapeHtml(verificationUrl)}</a></div>
      </div>
      <div style="margin-top:18px;padding:16px 18px;border-left:4px solid ${BRAND.neon};background:${BRAND.neonTint};font-size:13px;line-height:1.6;color:${BRAND.text};">The court owner will still review the application. Verification does not automatically approve host access.</div>`,
    footerText:
      "You received this because a host application was submitted with this email. If that was not you, you can safely ignore this message.",
  });
  const text = [
    "PADDLE RAGE PICKLEBALL",
    "Host application email verification",
    "",
    `Hi ${fullName},`,
    "",
    "Your Open Play host application has been received. Verify that this email belongs to you before the court owner can activate host access:",
    verificationUrl,
    "",
    "This one-use link expires in 1 hour.",
    "",
    "Verification does not automatically approve the application.",
    "If you did not submit it, ignore this message.",
  ].join("\n");
  return { html, plain: text };
}

export function renderConfirmationEmail(
  payload: ConfirmationPayload,
): { html: string; plain: string } {
  const items = getConfirmationItems(payload);
  const name = escapeHtml(payload.fullName || "Player");
  const ref = escapeHtml(payload.bookingRef);
  const total = Number(
    payload.total ||
      items.reduce((sum, item) => sum + Number(item.total || 0), 0),
  );
  const hostBooking = payload.hostBooking === true;
  const paid = hostBooking ? Number(payload.downpayment || 0) : total;
  const remaining = hostBooking
    ? Math.max(
      0,
      Number.isFinite(Number(payload.remainingBalance))
        ? Number(payload.remainingBalance)
        : total - paid,
    )
    : 0;
  const paidInFull = remaining < 1;
  const confirmationIntro = paidInFull
    ? "we received your full payment, and your Paddle Rage booking is confirmed. Everything you need is below."
    : paid > 0
    ? "we received your downpayment, and your Paddle Rage booking is confirmed. Everything you need is below."
    : "your Paddle Rage booking is confirmed. No payment has been recorded yet, so please review the payment details below.";
  const confirmationPlain = paidInFull
    ? "We received your full payment, and your booking is confirmed."
    : paid > 0
    ? "We received your downpayment, and your booking is confirmed."
    : "Your booking is confirmed. No payment has been recorded yet.";
  const duration =
    items.reduce((sum, item) => sum + Number(item.duration || 0), 0) ||
    Number(payload.duration || 0);
  const courts =
    [...new Set(items.map((item) => plain(item.courtName)).filter(Boolean))]
      .join(", ") || plain(payload.courtName);
  const firstDate = items[0]?.date || payload.date;
  const scheduleRows = items.map((item, index) => `
    <tr>
      <td style="padding:${index ? "13px 0 0" : "0"};vertical-align:top;">
        <div style="font-size:14px;line-height:1.45;font-weight:800;color:${BRAND.text};">${
    escapeHtml(item.courtName)
  }</div>
        <div style="margin-top:3px;font-size:14px;line-height:1.5;color:${BRAND.muted};">${
    escapeHtml(formatDate(item.date))
  }<br>${escapeHtml(item.startTime)} &ndash; ${escapeHtml(item.endTime)}</div>
      </td>
      <td align="right" style="padding:${
    index ? "13px 0 0 12px" : "0 0 0 12px"
  };vertical-align:top;white-space:nowrap;font-size:14px;line-height:1.45;font-weight:800;color:${BRAND.text};">${
    formatPhp(Number(item.total || 0))
  }</td>
    </tr>`).join("");
  const deadline = hostBooking && !paidInFull
    ? formatDeadline(payload.balanceDueAt)
    : "";
  const paymentCopy = paidInFull
    ? "Your payment is complete. There is no remaining balance."
    : deadline
    ? `Your remaining balance of <strong style="color:${BRAND.text};">${
      formatPhp(remaining)
    }</strong> is due by <strong>${escapeHtml(deadline)}</strong>.`
    : `Your remaining balance of <strong style="color:${BRAND.text};">${
      formatPhp(remaining)
    }</strong> is due on the day of play.`;

  const bodyHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;background:${BRAND.surfaceRaised};border:1px solid ${BRAND.border};border-radius:13px;">
      <tr><td style="padding:18px 20px;">
        <div style="font-size:11px;line-height:1.3;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${BRAND.muted};">Booking reference</div>
        <div style="margin-top:5px;font-family:Consolas,'Courier New',monospace;font-size:19px;line-height:1.35;font-weight:900;letter-spacing:.8px;color:${BRAND.neon};overflow-wrap:anywhere;">${ref}</div>
      </td></tr>
    </table>
    <table role="presentation" class="detail-table" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;border:1px solid ${BRAND.border};border-radius:13px;">
      <tr><td style="padding:18px 20px;border-bottom:1px solid ${BRAND.border};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${scheduleRows}</table>
      </td></tr>
      <tr><td style="padding:16px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td class="stack-cell" width="50%" style="width:50%;vertical-align:top;">
            <div style="font-size:11px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Court${
    items.length > 1 ? "s" : ""
  }</div>
            <div style="margin-top:4px;font-size:14px;line-height:1.5;font-weight:800;color:${BRAND.text};">${
    escapeHtml(courts)
  }</div>
          </td>
          <td class="stack-cell stack-gap" width="50%" style="width:50%;vertical-align:top;">
            <div style="font-size:11px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Total court time</div>
            <div style="margin-top:4px;font-size:14px;line-height:1.5;font-weight:800;color:${BRAND.text};">${duration} hour${
    duration !== 1 ? "s" : ""
  }</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;background:${BRAND.neonTint};border:1px solid ${BRAND.neonDark};border-radius:13px;">
      <tr><td style="padding:17px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td class="stack-cell" width="33.33%" style="width:33.33%;vertical-align:top;">
            <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${BRAND.muted};">Total</div>
            <div style="margin-top:4px;font-size:16px;line-height:1.4;font-weight:900;color:${BRAND.text};">${
    formatPhp(total)
  }</div>
          </td>
          <td class="stack-cell stack-gap" width="33.33%" style="width:33.33%;vertical-align:top;">
            <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${BRAND.muted};">Paid</div>
            <div style="margin-top:4px;font-size:16px;line-height:1.4;font-weight:900;color:${BRAND.neon};">${
    formatPhp(paid)
  }</div>
          </td>
          <td class="stack-cell stack-gap" width="33.33%" style="width:33.33%;vertical-align:top;">
            <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${BRAND.muted};">Balance</div>
            <div style="margin-top:4px;font-size:16px;line-height:1.4;font-weight:900;color:${
    paidInFull ? BRAND.neon : BRAND.danger
  };">${paidInFull ? "Paid in full" : formatPhp(remaining)}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${BRAND.surfaceRaised};border-left:4px solid ${BRAND.neon};border-radius:8px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:13px;line-height:1.55;font-weight:900;color:${BRAND.text};">Before you arrive</div>
        <div style="margin-top:7px;font-size:14px;line-height:1.7;color:${BRAND.text};">
          &bull; Please arrive 10 minutes early.<br>
          &bull; Keep booking reference <strong>${ref}</strong> ready.<br>
          &bull; ${paymentCopy}
          ${
    hostBooking && deadline && !paidInFull
      ? "<br>&bull; Missing the host balance deadline forfeits the reservation and releases the slot; payments already made remain non-refundable."
      : ""
  }
        </div>
      </td></tr>
    </table>`;

  const plainSchedules = items.map((item) =>
    `- ${plain(item.courtName)} | ${formatDate(item.date)} | ${
      plain(item.startTime)
    } - ${plain(item.endTime)} | ${formatPhpPlain(Number(item.total || 0))}`
  ).join("\n");
  const plainPayment = paidInFull
    ? "Payment status: Paid in full"
    : `Remaining balance: ${formatPhpPlain(remaining)}${
      deadline ? `\nBalance due: ${deadline}` : " (due on the day of play)"
    }`;

  return {
    html: layout({
      preheader: `Booking ${plain(payload.bookingRef)} is confirmed for ${
        formatDate(firstDate)
      }.`,
      status: "BOOKING CONFIRMED",
      statusBackground: BRAND.neon,
      statusColor: BRAND.black,
      title: "Your court is locked in.",
      introHtml:
        `<p style="margin:0 0 10px;">Hi <strong>${name}</strong>,</p><p style="margin:0;">Great news&mdash;${confirmationIntro}</p>`,
      bodyHtml,
      footerText:
        "Questions or changes? Contact the Paddle Rage team and include your booking reference.",
    }),
    plain: `PADDLE RAGE PICKLEBALL\nBOOKING CONFIRMED\n\nHi ${
      plain(payload.fullName || "Player")
    },\n\n${confirmationPlain}\n\nBooking reference: ${
      plain(payload.bookingRef)
    }\n\nSCHEDULE\n${plainSchedules}\n\nTotal court time: ${duration} hour${
      duration !== 1 ? "s" : ""
    }\nTotal: ${formatPhpPlain(total)}\nPaid: ${
      formatPhpPlain(paid)
    }\n${plainPayment}\n\nPlease arrive 10 minutes early and keep your booking reference ready.\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\n${publicUrl()}`,
  };
}

export function renderRescheduleEmail(
  payload: ReschedulePayload,
): { html: string; plain: string } {
  const name = escapeHtml(payload.fullName || "Player");
  const ref = escapeHtml(payload.bookingRef);
  const oldDate = formatDate(payload.oldDate);
  const newDate = formatDate(payload.newDate);
  const note = plain(payload.note);
  const noteHtml = note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;background:${BRAND.surfaceRaised};border-left:4px solid ${BRAND.neon};border-radius:8px;"><tr><td style="padding:15px 17px;"><div style="font-size:12px;line-height:1.4;font-weight:900;text-transform:uppercase;letter-spacing:.7px;color:${BRAND.neon};">Message from our team</div><div style="margin-top:6px;font-size:14px;line-height:1.65;color:${BRAND.text};">${
      escapeHtml(note)
    }</div></td></tr></table>`
    : "";
  const bodyHtml = `
    ${noteHtml}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
      <tr>
        <td class="stack-cell" width="48%" style="width:48%;vertical-align:top;background:${BRAND.dangerTint};border:1px solid ${BRAND.danger};border-radius:12px;padding:17px;box-sizing:border-box;">
          <div style="font-size:10px;line-height:1.3;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:${BRAND.danger};">Previous schedule</div>
          <div style="margin-top:8px;font-size:14px;line-height:1.55;color:${BRAND.muted};text-decoration:line-through;">${
    escapeHtml(oldDate)
  }<br>${escapeHtml(payload.oldStartTime)} &ndash; ${
    escapeHtml(payload.oldEndTime)
  }</div>
        </td>
        <td class="stack-cell" width="4%" style="width:4%;font-size:0;line-height:0;">&nbsp;</td>
        <td class="stack-cell stack-gap" width="48%" style="width:48%;vertical-align:top;background:${BRAND.neonTint};border:1px solid ${BRAND.neonDark};border-radius:12px;padding:17px;box-sizing:border-box;">
          <div style="font-size:10px;line-height:1.3;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:${BRAND.neon};">New schedule</div>
          <div style="margin-top:8px;font-size:15px;line-height:1.55;font-weight:900;color:${BRAND.text};">${
    escapeHtml(newDate)
  }<br>${escapeHtml(payload.newStartTime)} &ndash; ${
    escapeHtml(payload.newEndTime)
  }</div>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;border:1px solid ${BRAND.border};border-radius:13px;">
      <tr><td style="padding:17px 20px;border-bottom:1px solid ${BRAND.border};">
        <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Booking reference</div>
        <div style="margin-top:4px;font-family:Consolas,'Courier New',monospace;font-size:17px;line-height:1.4;font-weight:900;color:${BRAND.neon};overflow-wrap:anywhere;">${ref}</div>
      </td></tr>
      <tr><td style="padding:17px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td class="stack-cell" width="65%" style="width:65%;vertical-align:top;">
            <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Court</div>
            <div style="margin-top:4px;font-size:14px;line-height:1.5;font-weight:800;color:${BRAND.text};">${
    escapeHtml(payload.courtName)
  }</div>
          </td>
          <td class="stack-cell stack-gap" width="35%" style="width:35%;vertical-align:top;">
            <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Duration</div>
            <div style="margin-top:4px;font-size:14px;line-height:1.5;font-weight:800;color:${BRAND.text};">${
    Number(payload.newDuration || 0)
  } hour${Number(payload.newDuration || 0) !== 1 ? "s" : ""}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
    <div style="font-size:14px;line-height:1.7;color:${BRAND.muted};">Please use the new schedule above when planning your visit. Your booking reference and all other booking details remain unchanged.</div>`;

  return {
    html: layout({
      preheader: `Booking ${plain(payload.bookingRef)} moved to ${newDate}, ${
        plain(payload.newStartTime)
      }.`,
      status: "BOOKING RESCHEDULED",
      statusBackground: BRAND.danger,
      statusColor: "#ffffff",
      title: "Your booking has a new schedule.",
      introHtml:
        `<p style="margin:0 0 10px;">Hi <strong>${name}</strong>,</p><p style="margin:0;">Your Paddle Rage booking has been moved to the new date and time shown below. Your slot remains secure.</p>`,
      bodyHtml,
      footerText:
        "Need help with the new schedule? Contact the Paddle Rage team and include your booking reference.",
    }),
    plain: `PADDLE RAGE PICKLEBALL\nBOOKING RESCHEDULED\n\nHi ${
      plain(payload.fullName || "Player")
    },\n\nYour booking has been moved. Your slot remains secure.\n\nBooking reference: ${
      plain(payload.bookingRef)
    }\nCourt: ${plain(payload.courtName)}\n\nPREVIOUS SCHEDULE\n${oldDate}\n${
      plain(payload.oldStartTime)
    } - ${plain(payload.oldEndTime)}\n\nNEW SCHEDULE\n${newDate}\n${
      plain(payload.newStartTime)
    } - ${plain(payload.newEndTime)}\nDuration: ${
      Number(payload.newDuration || 0)
    } hour${Number(payload.newDuration || 0) !== 1 ? "s" : ""}${
      note ? `\n\nMessage from our team: ${note}` : ""
    }\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\n${publicUrl()}`,
  };
}

export function renderBookingCancellationEmail(
  payload: BookingCancellationPayload,
): { html: string; plain: string } {
  const rejected = Boolean(payload.paymentRejected);
  const name = plain(payload.fullName) || "Player";
  const reason = plain(payload.reason) ||
    (rejected
      ? "The submitted payment could not be verified."
      : "The booking was cancelled by the Paddle Rage team.");
  const paid = Math.max(0, Number(payload.paid || 0));
  const title = rejected
    ? "Your payment could not be verified."
    : "Your booking has been cancelled.";
  const status = rejected
    ? "PAYMENT REJECTED · BOOKING CANCELLED"
    : "BOOKING CANCELLED";
  const paymentNote = paid > 0
    ? `Our records show ${
      formatPhp(paid)
    } received. Contact the Paddle Rage team and include your booking reference if you need the payment reviewed.`
    : "No settled payment is recorded for this booking.";
  const bodyHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;background:${BRAND.dangerTint};border:1px solid ${BRAND.danger};border-radius:13px;">
      <tr><td style="padding:18px 20px;">
        <div style="font-size:11px;line-height:1.3;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:${BRAND.danger};">Reason</div>
        <div style="margin-top:7px;font-size:15px;line-height:1.65;color:${BRAND.text};">${
    escapeHtml(reason)
  }</div>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;border:1px solid ${BRAND.border};border-radius:13px;">
      <tr><td style="padding:17px 20px;border-bottom:1px solid ${BRAND.border};">
        <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Booking reference</div>
        <div style="margin-top:4px;font-family:Consolas,'Courier New',monospace;font-size:17px;line-height:1.4;font-weight:900;color:${BRAND.neon};overflow-wrap:anywhere;">${
    escapeHtml(payload.bookingRef)
  }</div>
      </td></tr>
      <tr><td style="padding:17px 20px;">
        <div style="font-size:10px;line-height:1.3;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Released schedule</div>
        <div style="margin-top:5px;font-size:14px;line-height:1.6;font-weight:800;color:${BRAND.text};">${
    escapeHtml(payload.courtName)
  }<br>${escapeHtml(formatDate(payload.date))}<br>${
    escapeHtml(payload.startTime)
  } &ndash; ${escapeHtml(payload.endTime)}</div>
      </td></tr>
    </table>
    <div style="padding:16px 18px;background:${BRAND.surfaceRaised};border-left:4px solid ${BRAND.neon};border-radius:8px;font-size:14px;line-height:1.7;color:${BRAND.text};">${paymentNote}<br>The court slot has been released. If you still want to play, please create a new booking for an available schedule.</div>`;

  return {
    html: layout({
      preheader: `${status}: ${plain(payload.bookingRef)}.`,
      status,
      statusBackground: BRAND.danger,
      statusColor: "#ffffff",
      title,
      introHtml: `<p style="margin:0 0 10px;">Hi <strong>${
        escapeHtml(name)
      }</strong>,</p><p style="margin:0;">This message confirms that the reservation below is no longer active.</p>`,
      bodyHtml,
      footerText:
        "Questions about this cancellation? Reply to this email or contact the Paddle Rage team with your booking reference.",
    }),
    plain:
      `PADDLE RAGE PICKLEBALL\n${status}\n\nHi ${name},\n\n${reason}\n\nBooking reference: ${
        plain(payload.bookingRef)
      }\nCourt: ${plain(payload.courtName)}\nReleased schedule: ${
        formatDate(payload.date)
      }, ${plain(payload.startTime)} - ${plain(payload.endTime)}\nTotal: ${
        formatPhpPlain(payload.total)
      }\nRecorded paid amount: ${formatPhpPlain(paid)}\n\n${
        paid > 0
          ? "Contact the Paddle Rage team with your booking reference if you need the payment reviewed."
          : "No settled payment is recorded for this booking."
      }\nThe court slot has been released. Create a new booking if you still want to play.\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\n${publicUrl()}`,
  };
}

export function renderBalanceNoticeEmail(
  payload: BalanceNoticePayload,
): { html: string; plain: string; subject: string } {
  const forfeited = payload.eventType === "forfeited";
  const days = payload.eventType === "reminder_3d"
    ? 3
    : payload.eventType === "reminder_2d"
    ? 2
    : 1;
  const heading = forfeited
    ? "RESERVATION FORFEITED"
    : days === 1
    ? "FINAL BALANCE REMINDER"
    : `${days} DAYS REMAINING`;
  const subject = forfeited
    ? "Reservation forfeited - slot released"
    : days === 1
    ? "Final balance reminder - 24 hours remaining"
    : `${days} days remaining to settle your balance`;
  const deadline = formatDeadline(payload.deadline);
  const scheduleRows = payload.schedules.map((item) =>
    `<div style="margin-top:5px;font-size:14px;line-height:1.55;color:${BRAND.text};">${
      escapeHtml(formatDate(item.date))
    }<br>${escapeHtml(item.startTime)} &ndash; ${
      escapeHtml(item.endTime)
    }</div>`
  ).join("");
  const message = forfeited
    ? `The remaining balance of <strong>${
      formatPhp(payload.remainingBalance)
    }</strong> was not paid by the deadline. The slot has been released and payments already made remain non-refundable.`
    : `Please settle the remaining balance of <strong>${
      formatPhp(payload.remainingBalance)
    }</strong> by <strong>${
      escapeHtml(deadline)
    }</strong> to keep this reservation.${
      days === 1
        ? " If payment is not completed in time, the reservation will be forfeited and the slot released."
        : ""
    }`;
  const bodyHtml = `
    <div style="margin-bottom:20px;font-size:15px;line-height:1.7;color:${BRAND.text};">${message}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;background:${BRAND.surfaceRaised};border:1px solid ${BRAND.border};border-radius:13px;">
      <tr><td style="padding:16px 20px;border-bottom:1px solid ${BRAND.border};"><div style="font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Booking reference</div><div style="margin-top:5px;font-family:Consolas,'Courier New',monospace;font-size:17px;font-weight:900;color:${BRAND.neon};overflow-wrap:anywhere;">${
    escapeHtml(payload.bookingRef)
  }</div></td></tr>
      <tr><td style="padding:16px 20px;border-bottom:1px solid ${BRAND.border};"><div style="font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Court and schedule</div><div style="margin-top:5px;font-size:14px;font-weight:900;color:${BRAND.text};">${
    escapeHtml(payload.courtName)
  }</div>${scheduleRows}</td></tr>
      <tr><td style="padding:16px 20px;"><table role="presentation" width="100%"><tr><td class="stack-cell" width="50%"><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:${BRAND.muted};">Paid</div><div style="margin-top:4px;font-size:16px;font-weight:900;color:${BRAND.text};">${
    formatPhp(payload.paid)
  }</div></td><td class="stack-cell stack-gap" width="50%"><div style="font-size:10px;font-weight:900;text-transform:uppercase;color:${BRAND.muted};">Remaining balance</div><div style="margin-top:4px;font-size:16px;font-weight:900;color:${
    forfeited ? BRAND.danger : BRAND.warning
  };">${formatPhp(payload.remainingBalance)}</div></td></tr></table></td></tr>
    </table>
    ${
    forfeited
      ? ""
      : `<div style="padding:15px 17px;background:${BRAND.warningTint};border-left:4px solid ${BRAND.warning};border-radius:8px;font-size:13px;line-height:1.65;color:${BRAND.text};">Deadline: <strong>${
        escapeHtml(deadline)
      }</strong><br>Use the payment instructions from your original confirmation or contact the Paddle Rage team before the deadline.</div>`
  }`;
  const plainSchedules = payload.schedules.map((item) =>
    `- ${formatDate(item.date)} | ${plain(item.startTime)} - ${
      plain(item.endTime)
    }`
  ).join("\n");
  const action = forfeited
    ? `The remaining balance of ${
      formatPhpPlain(payload.remainingBalance)
    } was not paid by the deadline. The slot was released and payments already made remain non-refundable.`
    : `Please pay ${
      formatPhpPlain(payload.remainingBalance)
    } by ${deadline} to keep the reservation.`;

  return {
    subject,
    html: layout({
      preheader: `${heading}: ${plain(payload.bookingRef)}.`,
      status: heading,
      statusBackground: forfeited ? BRAND.danger : BRAND.warning,
      statusColor: BRAND.black,
      title: forfeited
        ? "Your court slot was released."
        : "Keep your host reservation active.",
      introHtml: `<p style="margin:0;">Hi <strong>${
        escapeHtml(payload.fullName || "Host")
      }</strong>,</p>`,
      bodyHtml,
      footerText:
        "This is an automated reservation notice. Contact the Paddle Rage team with your booking reference if you need help.",
    }),
    plain: `PADDLE RAGE PICKLEBALL\n${heading}\n\nHi ${
      plain(payload.fullName || "Host")
    },\n\n${action}\n\nBooking reference: ${
      plain(payload.bookingRef)
    }\nCourt: ${plain(payload.courtName)}\n${plainSchedules}\nPaid: ${
      formatPhpPlain(payload.paid)
    }\nRemaining balance: ${
      formatPhpPlain(payload.remainingBalance)
    }\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\n${publicUrl()}`,
  };
}

export function renderHostDecisionEmail(
  payload: HostDecisionPayload,
): { html: string; plain: string } {
  const approved = payload.status === "approved";
  const name = plain(payload.fullName) || "Host applicant";
  const note = plain(payload.reviewNote);
  const hostUrl = `${publicUrl()}/host.html`;
  const nextStep = approved
    ? `Your host access is active. Sign in using the email and password from your application.`
    : `Host access was not activated. You may contact the Paddle Rage team if you need clarification or want to submit updated information.`;
  const bodyHtml = `
    ${
    note
      ? `<div style="margin-bottom:20px;padding:17px 19px;background:${BRAND.surfaceRaised};border-left:4px solid ${
        approved ? BRAND.neon : BRAND.danger
      };border-radius:8px;"><div style="font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${BRAND.muted};">Review note</div><div style="margin-top:6px;font-size:14px;line-height:1.65;color:${BRAND.text};">${
        escapeHtml(note)
      }</div></div>`
      : ""
  }
    <div style="padding:18px 20px;border:1px solid ${BRAND.border};border-radius:13px;background:${
    approved ? BRAND.neonTint : BRAND.dangerTint
  };font-size:14px;line-height:1.7;color:${BRAND.text};">${nextStep}</div>
    ${
    approved
      ? `<div style="margin-top:22px;text-align:center;"><a href="${
        escapeHtml(hostUrl)
      }" style="display:inline-block;padding:14px 24px;border-radius:10px;background:${BRAND.neon};color:${BRAND.black};font-size:15px;font-weight:900;text-decoration:none;">Open host dashboard</a></div>`
      : ""
  }`;

  return {
    html: layout({
      preheader: `Your Paddle Rage host application was ${payload.status}.`,
      status: `HOST APPLICATION ${payload.status.toUpperCase()}`,
      statusBackground: approved ? BRAND.neon : BRAND.danger,
      statusColor: approved ? BRAND.black : "#ffffff",
      title: approved
        ? "Welcome to the host team."
        : "Your application was not approved.",
      introHtml: `<p style="margin:0;">Hi <strong>${
        escapeHtml(name)
      }</strong>, your Open Play host application has been reviewed.</p>`,
      bodyHtml,
      footerText:
        "Questions about this decision? Reply to this email or contact the Paddle Rage team.",
    }),
    plain:
      `PADDLE RAGE PICKLEBALL\nHOST APPLICATION ${payload.status.toUpperCase()}\n\nHi ${name},\n\nYour Open Play host application was ${payload.status}.\n${
        note ? `Review note: ${note}\n` : ""
      }${nextStep}${
        approved ? `\nHost dashboard: ${hostUrl}` : ""
      }\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\n${publicUrl()}`,
  };
}
