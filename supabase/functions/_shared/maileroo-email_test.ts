import { sendMailerooEmail } from "./maileroo.ts";
import { confirmedBookingPaidAmount } from "./booking-email-payment.ts";
import {
  renderBalanceNoticeEmail,
  renderBookingCancellationEmail,
  renderBookingPaymentTransferEmail,
  renderConfirmationEmail,
  renderHostDecisionEmail,
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
    hostBooking: true,
    balanceDueAt: "2026-07-20T18:00:00+08:00",
  });

  assert(
    email.html.includes("@media only screen and (max-width:620px)"),
    "mobile styles missing",
  );
  assert(
    email.html.includes("#050706") && email.html.includes("#b6f000") &&
      email.html.includes("#f6f8f2"),
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
    email.html.includes("#050706") && email.html.includes("#b6f000") &&
      email.html.includes("#f6f8f2"),
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

Deno.test("regular confirmation uses full-payment language and has no balance", () => {
  const email = renderConfirmationEmail({
    bookingRef: "PR-TEST-FULL",
    email: "player@example.com",
    fullName: "Taylor",
    courtName: "Center Court",
    date: "2026-07-25",
    startTime: "6:00 PM",
    endTime: "8:00 PM",
    duration: 2,
    total: 800,
    downpayment: 800,
    remainingBalance: 0,
  });

  assert(
    email.html.includes(
      "Great news&mdash;we received your full payment",
    ),
    "regular full-payment confirmation grammar regressed",
  );
  assert(
    email.html.includes("There is no remaining balance"),
    "regular paid-in-full disclosure missing",
  );
  assert(
    !email.html.includes("received your downpayment") &&
      !email.html.includes("due on the day of play"),
    "regular booking contains partial-payment language",
  );
  assert(
    email.plain.includes("Paid: PHP 800.00") &&
      email.plain.includes("Payment status: Paid in full"),
    "regular full-payment plain text is incomplete",
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

Deno.test("cancellation email explains the released slot and payment state", () => {
  const email = renderBookingCancellationEmail({
    bookingRef: "PR-CANCEL-001",
    fullName: "Jamie",
    courtName: "Rage Court",
    date: "2026-07-25",
    startTime: "6:00 PM",
    endTime: "8:00 PM",
    total: 800,
    paid: 0,
    paymentRejected: true,
    reason: "Receipt reference did not match <script>alert(1)</script>",
  });
  assert(
    email.html.includes("PAYMENT REJECTED · BOOKING CANCELLED"),
    "cancellation state missing",
  );
  assert(
    email.html.includes("court slot has been released"),
    "released-slot guidance missing",
  );
  assert(
    !email.html.includes("<script>alert(1)</script>"),
    "cancellation reason was not escaped",
  );
  assert(
    email.plain.includes("No settled payment is recorded"),
    "plain payment state missing",
  );
});

Deno.test("payment-transfer email is explicit, complete, and escapes every operator-controlled value", () => {
  const email = renderBookingPaymentTransferEmail({
    sourceBookingRef: "OLD-<script>alert(1)</script>",
    targetBookingRef: "NEW-&-002",
    fullName: "Jamie <img src=x onerror=alert(2)>",
    courtName: "Court <Three>",
    date: "2026-10-06",
    startTime: "7:00 PM",
    endTime: "11:00 PM",
    amount: 1290,
    reason: "Player corrected the reservation <script>alert(3)</script>",
  });

  assert(
    email.html.includes("PAYMENT MOVED · BOOKING CONFIRMED") &&
      email.html.includes("Cancelled booking") &&
      email.html.includes("Confirmed booking"),
    "transfer lifecycle and both booking sides must be unmistakable",
  );
  assert(
    email.html.includes("PHP") === false && email.plain.includes("PHP 1,290.00"),
    "HTML must use the shared peso formatting while plain text keeps an accessible currency label",
  );
  assert(
    email.plain.includes("OLD-<script>alert(1)</script>") &&
      email.plain.includes("NEW-&-002") &&
      email.plain.includes("No new charge was made"),
    "plain text must include both references and the no-new-charge explanation",
  );
  for (const rawHtml of [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(2)>",
    "<script>alert(3)</script>",
    "Court <Three>",
  ]) {
    assert(!email.html.includes(rawHtml), `unsafe HTML was not escaped: ${rawHtml}`);
  }
  assert(
    email.html.includes("OLD-&lt;script&gt;alert(1)&lt;/script&gt;") &&
      email.html.includes("NEW-&amp;-002") &&
      email.html.includes("Jamie &lt;img src=x onerror=alert(2)&gt;") &&
      email.html.includes("Court &lt;Three&gt;") &&
      email.html.includes("Player corrected the reservation &lt;script&gt;alert(3)&lt;/script&gt;"),
    "escaped transfer content is missing",
  );
});

Deno.test("balance reminders and host decisions use the shared dark neon layout", () => {
  const balance = renderBalanceNoticeEmail({
    eventType: "reminder_1d",
    bookingRef: "PR-HOST-001",
    fullName: "Alex",
    courtName: "Center Court",
    schedules: [{
      date: "2026-07-25",
      startTime: "6:00 PM",
      endTime: "8:00 PM",
    }],
    paid: 400,
    remainingBalance: 400,
    deadline: "2026-07-24T18:00:00+08:00",
  });
  const decision = renderHostDecisionEmail({
    fullName: "Alex",
    status: "approved",
    reviewNote: "Approved for host access.",
  });
  assert(
    balance.html.includes("#050706") && balance.html.includes("#b6f000"),
    "balance email theme mismatch",
  );
  assert(
    balance.plain.includes("PR-HOST-001") &&
      balance.plain.includes("PHP 400.00"),
    "balance plain details missing",
  );
  assert(
    decision.html.includes("Open host dashboard"),
    "approved host action missing",
  );
  assert(
    decision.plain.includes("HOST APPLICATION APPROVED"),
    "host decision plain state missing",
  );
});
