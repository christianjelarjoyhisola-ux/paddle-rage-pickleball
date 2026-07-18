import { sendMailerooEmail } from "./maileroo.ts";
import { confirmedBookingPaidAmount } from "./booking-email-payment.ts";
import {
  renderConfirmationEmail,
  renderHostVerificationEmail,
  renderRescheduleEmail,
} from "./paddle-rage-email.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Maileroo transport sends the documented API shape without exposing its key", async () => {
  Deno.env.set("MAILEROO_API_KEY", "test-secret-key");
  Deno.env.set("MAILEROO_FROM_ADDRESS", "bookings@paddleragecdo.ph");
  Deno.env.set("MAILEROO_FROM_NAME", "Paddle Rage Pickleball");
  Deno.env.set("MAILEROO_REPLY_TO", "support@paddleragecdo.ph");
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetcher =
    (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        success: true,
        message: "Queued",
        data: { reference_id: "c843204e3af03193bd14f339" },
      });
    }) as typeof fetch;

  const result = await sendMailerooEmail({
    to: "player@example.com",
    toName: "Player One",
    subject: "Booking confirmed",
    html: "<p>Confirmed</p>",
    plain: "Confirmed",
    tags: { message_type: "booking-confirmation" },
  }, fetcher);

  assert(
    requestUrl === "https://smtp.maileroo.com/api/v2/emails",
    "wrong Maileroo endpoint",
  );
  assert(requestInit?.method === "POST", "email must use POST");
  const headers = new Headers(requestInit?.headers);
  assert(
    headers.get("authorization") === "Bearer test-secret-key",
    "missing bearer authentication",
  );
  const payload = JSON.parse(String(requestInit?.body || "{}"));
  assert(
    payload.from.address === "bookings@paddleragecdo.ph",
    "wrong sender address",
  );
  assert(payload.to[0].address === "player@example.com", "wrong recipient");
  assert(
    payload.reply_to.address === "support@paddleragecdo.ph",
    "wrong reply-to",
  );
  assert(payload.plain === "Confirmed", "plain-text fallback missing");
  assert(
    payload.tracking === false,
    "transactional tracking should be disabled",
  );
  assert(
    !String(requestInit?.body).includes("test-secret-key"),
    "API key leaked into request body",
  );
  assert(
    result.id === "c843204e3af03193bd14f339",
    "reference ID was not returned",
  );
});

Deno.test("confirmation email is responsive, readable, branded, and escapes customer content", () => {
  const email = renderConfirmationEmail({
    bookingRef: "PR-TEST-001",
    email: "player@example.com",
    fullName: "Alex <script>alert(1)</script>",
    courtName: "Center Court",
    date: "2026-07-25",
    startTime: "6:00 PM",
    endTime: "8:00 PM",
    duration: 2,
    total: 800,
    downpayment: 400,
    remainingBalance: 400,
  });

  assert(
    email.html.includes("@media only screen and (max-width:620px)"),
    "mobile styles missing",
  );
  assert(
    email.html.includes("#143d63") && email.html.includes("#c83d26") &&
      email.html.includes("#c9cf43"),
    "site palette missing",
  );
  assert(
    email.html.includes("Your court is locked in."),
    "confirmation headline missing",
  );
  assert(email.html.includes("PR-TEST-001"), "booking reference missing");
  assert(
    email.html.includes("PHP 400.00") === false,
    "HTML currency formatting regressed",
  );
  assert(
    !email.html.includes("<script>alert(1)</script>"),
    "customer name was not escaped",
  );
  assert(
    email.html.includes("Alex &lt;script&gt;alert(1)&lt;/script&gt;"),
    "escaped customer name missing",
  );
  assert(
    email.plain.includes("SCHEDULE") && email.plain.includes("PHP 400.00"),
    "plain-text details missing",
  );
  assert(
    email.html.includes("Great news&mdash;we received your downpayment"),
    "confirmation intro grammar regressed",
  );
});

Deno.test("host verification email is branded, readable, and keeps approval separate", () => {
  const email = renderHostVerificationEmail({
    fullName: "Alex <script>alert(1)</script>",
    verificationUrl: "https://example.com/verify?token=a&next=b",
  });

  assert(
    email.html.includes("Verify your email address") &&
      email.html.includes("Verify email address"),
    "verification heading or call-to-action missing",
  );
  assert(
    email.html.includes("#143d63") && email.html.includes("#c83d26") &&
      email.html.includes("#c9cf43"),
    "site palette missing",
  );
  assert(
    email.html.includes(
      "Verification does not automatically approve host access",
    ),
    "owner-review boundary missing",
  );
  assert(
    email.html.includes("expires in 1 hour") &&
      email.plain.includes("expires in 1 hour"),
    "verification expiry guidance missing",
  );
  assert(
    !email.html.includes("<script>alert(1)</script>") &&
      email.html.includes("Alex &lt;script&gt;alert(1)&lt;/script&gt;"),
    "applicant name was not escaped",
  );
  assert(
    email.html.includes("token=a&amp;next=b") &&
      email.plain.includes("https://example.com/verify?token=a&next=b"),
    "verification link missing or incorrectly escaped",
  );
});

Deno.test("confirmed-unpaid booking never describes an expected downpayment as received", () => {
  const paid = confirmedBookingPaidAmount({
    paymentStatus: "unpaid",
    total: 800,
    // This is the expected amount stored on the booking, not money received.
    downpayment: 400,
  });
  assert(paid === 0, "unpaid booking must report zero received");

  const email = renderConfirmationEmail({
    bookingRef: "PR-TEST-UNPAID",
    email: "player@example.com",
    fullName: "Taylor",
    courtName: "Center Court",
    date: "2026-07-25",
    startTime: "6:00 PM",
    endTime: "8:00 PM",
    duration: 2,
    total: 800,
    downpayment: paid,
    remainingBalance: 800,
  });

  assert(
    email.html.includes(
      "Great news&mdash;your Paddle Rage booking is confirmed",
    ),
    "unpaid confirmation grammar regressed",
  );
  assert(
    email.html.includes("No payment has been recorded yet"),
    "unpaid disclosure missing",
  );
  assert(
    !email.html.includes("received your downpayment") &&
      !email.html.includes("received your full payment"),
    "unpaid booking falsely claims payment receipt",
  );
  assert(
    email.plain.includes("Paid: PHP 0.00"),
    "plain text paid amount must be zero",
  );
});

Deno.test("confirmation paid amount follows only settled payment states", () => {
  const amount = (paymentStatus: string) =>
    confirmedBookingPaidAmount({
      paymentStatus,
      total: 800,
      downpayment: 400,
    });
  assert(amount("pending") === 0, "pending must not count as paid");
  assert(
    amount("for_verification") === 0,
    "verification must not count as paid",
  );
  assert(amount("downpayment_paid") === 400, "settled downpayment missing");
  assert(amount("deposit_retained") === 400, "retained deposit missing");
  assert(amount("paid") === 800, "full payment must count total");
});

Deno.test("reschedule email makes the old and new schedules clear and escapes the note", () => {
  const email = renderRescheduleEmail({
    bookingRef: "PR-TEST-002",
    email: "player@example.com",
    fullName: "Jamie",
    courtName: "Rage Court",
    oldDate: "2026-07-25",
    oldStartTime: "6:00 PM",
    oldEndTime: "8:00 PM",
    newDate: "2026-07-26",
    newStartTime: "7:00 PM",
    newEndTime: "9:00 PM",
    newDuration: 2,
    note: "Bring friends <img src=x onerror=alert(1)>",
  });

  assert(
    email.html.includes("Previous schedule") &&
      email.html.includes("New schedule"),
    "schedule comparison missing",
  );
  assert(
    !email.html.includes("<img src=x onerror=alert(1)>"),
    "admin note was not escaped",
  );
  assert(
    email.html.includes("&lt;img src=x onerror=alert(1)&gt;"),
    "escaped admin note missing",
  );
  assert(
    email.plain.includes("PREVIOUS SCHEDULE") &&
      email.plain.includes("NEW SCHEDULE"),
    "plain comparison missing",
  );
});
