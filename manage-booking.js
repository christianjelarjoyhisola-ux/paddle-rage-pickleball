(function () {
  "use strict";

  const MAX_RESULT_ROWS = 8;
  const DEFAULT_CONTACT_EMAIL = "bookings@paddleragecdo.ph";
  const currencyFormatter = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  });
  const dateFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const bookingStatusMeta = {
    confirmed: {
      label: "Confirmed",
      tone: "success",
      message: "Your booking is confirmed and your court is secured.",
    },
    completed: {
      label: "Completed",
      tone: "neutral",
      message: "This booking has been completed.",
    },
    pending: {
      label: "Pending confirmation",
      tone: "warning",
      message: "Your booking was received and is waiting for final confirmation.",
    },
    verifying: {
      label: "Verification in progress",
      tone: "warning",
      message: "Your booking and payment evidence are still being checked. Please do not pay again.",
    },
    cancelled: {
      label: "Cancelled",
      tone: "danger",
      message: "This booking is cancelled and its original court time is no longer reserved.",
    },
    forfeited: {
      label: "Forfeited",
      tone: "danger",
      message: "This reservation is no longer active. Contact Paddle Rage if you need help understanding its status.",
    },
  };

  const paymentStatusMeta = {
    paid: { label: "Paid in full", tone: "success" },
    downpayment_paid: { label: "Deposit recorded", tone: "success" },
    for_verification: { label: "Payment under review", tone: "warning" },
    balance_due: { label: "Balance due", tone: "warning" },
    unpaid: { label: "Payment not recorded", tone: "neutral" },
    rejected: { label: "Payment rejected", tone: "danger" },
    deposit_retained: { label: "Payment retained", tone: "danger" },
  };

  let form;
  let refInput;
  let emailInput;
  let lookupButton;
  let resultRegion;
  let formFeedback;

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function normalizeReference(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
  }

  function referenceLooksValid(value) {
    return /^PB-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value) && value.length <= 72;
  }

  function emailLooksValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function formatCurrency(value) {
    return currencyFormatter.format(safeNumber(value));
  }

  function formatDate(value) {
    const raw = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "Date unavailable";
    const date = new Date(`${raw}T12:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? raw : dateFormatter.format(date);
  }

  function formatHour(hour) {
    const normalized = ((Number(hour) % 24) + 24) % 24;
    const period = normalized < 12 ? "AM" : "PM";
    const displayHour = normalized % 12 || 12;
    return `${displayHour}:00 ${period}`;
  }

  function formatTimeRange(row) {
    const slots = Array.isArray(row.slots)
      ? row.slots.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
      : [];
    if (slots.length) {
      const ranges = [];
      let rangeStart = slots[0];
      let rangeEnd = slots[0];
      for (let index = 1; index < slots.length; index += 1) {
        if (slots[index] === rangeEnd + 1) {
          rangeEnd = slots[index];
        } else {
          ranges.push([rangeStart, rangeEnd]);
          rangeStart = slots[index];
          rangeEnd = slots[index];
        }
      }
      ranges.push([rangeStart, rangeEnd]);
      return ranges
        .map(([first, last]) => `${formatHour(first)} – ${formatHour(last + 1)}`)
        .join(", ");
    }

    const start = String(row.startTime || "").trim();
    const end = String(row.endTime || "").trim();
    if (start && end) return `${start} – ${end}`;
    return start || end || "Time unavailable";
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function naturalList(values) {
    const list = unique(values);
    if (list.length < 2) return list[0] || "—";
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
  }

  function paymentMethodLabel(value) {
    const key = String(value || "").trim().toLowerCase();
    const labels = {
      gcash: "GCash",
      gcash_gateway: "GCash",
      maya: "Maya",
      bdopay: "BDO Pay",
      bpi: "BPI",
      gotyme: "GoTyme",
      maribank: "MariBank",
      pnb: "PNB",
      cash: "Cash",
    };
    return labels[key] || (key ? key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Not available");
  }

  function contactEmail() {
    const configured = String(
      window.PB_MANAGE_BOOKING_CONTACT_EMAIL
      || document.querySelector('meta[name="paddle-rage-contact-email"]')?.content
      || DEFAULT_CONTACT_EMAIL,
    ).trim();
    return emailLooksValid(configured) ? configured : DEFAULT_CONTACT_EMAIL;
  }

  function contactHref(reference, subjectPrefix) {
    const subject = `${subjectPrefix || "Booking help"}${reference ? ` — ${reference}` : ""}`;
    return `mailto:${encodeURIComponent(contactEmail())}?subject=${encodeURIComponent(subject)}`;
  }

  function makeContactButton(reference, label, subjectPrefix, className) {
    const link = element("a", className || "contact-button", label || "Contact Paddle Rage");
    link.href = contactHref(reference, subjectPrefix);
    return link;
  }

  function setLoading(isLoading) {
    lookupButton.disabled = isLoading;
    lookupButton.classList.toggle("is-loading", isLoading);
    lookupButton.setAttribute("aria-busy", String(isLoading));
    lookupButton.querySelector(".button-label").textContent = isLoading ? "Finding your booking…" : "Find my booking";
    resultRegion.setAttribute("aria-busy", String(isLoading));
  }

  function clearValidation() {
    refInput.setAttribute("aria-invalid", "false");
    emailInput.setAttribute("aria-invalid", "false");
    formFeedback.textContent = "";
  }

  function validationError(input, message) {
    input.setAttribute("aria-invalid", "true");
    formFeedback.textContent = message;
    input.focus();
  }

  function focusResult() {
    window.requestAnimationFrame(() => resultRegion.focus({ preventScroll: false }));
  }

  function renderLoadingState() {
    const card = element("div", "state-card");
    const heading = element("div", "state-heading");
    const icon = element("span", "state-icon", "…");
    icon.setAttribute("aria-hidden", "true");
    const copy = element("div");
    copy.append(
      element("h2", "", "Securely checking your booking"),
      element("p", "", "This usually takes only a moment."),
    );
    heading.append(icon, copy);
    card.append(heading);
    resultRegion.replaceChildren(card);
  }

  function renderMessageState(options) {
    const tone = options.tone === "warning" ? "is-warning" : "is-error";
    const card = element("div", `state-card ${tone}`);
    if (options.alert !== false) card.setAttribute("role", "alert");
    const heading = element("div", "state-heading");
    const icon = element("span", "state-icon", options.tone === "warning" ? "!" : "×");
    icon.setAttribute("aria-hidden", "true");
    const copy = element("div");
    copy.append(element("h2", "", options.title), element("p", "", options.message));
    heading.append(icon, copy);
    card.append(heading);
    if (options.contact) {
      card.append(makeContactButton(options.reference, "Contact Paddle Rage", "Booking access help"));
    }
    resultRegion.replaceChildren(card);
    focusResult();
  }

  function aggregateBookingStatus(rows) {
    const values = unique(rows.map((row) => String(row.status || "").trim().toLowerCase()));
    if (values.length === 1 && bookingStatusMeta[values[0]]) return bookingStatusMeta[values[0]];
    if (values.includes("verifying")) return bookingStatusMeta.verifying;
    if (values.includes("pending")) return bookingStatusMeta.pending;
    if (values.every((status) => status === "cancelled")) return bookingStatusMeta.cancelled;
    if (values.every((status) => status === "completed")) return bookingStatusMeta.completed;
    return {
      label: "Status update",
      tone: "neutral",
      message: "This booking contains items at different stages. Review each schedule below or contact Paddle Rage for help.",
    };
  }

  function aggregatePaymentStatus(rows) {
    const values = unique(rows.map((row) => String(row.paymentStatus || "").trim().toLowerCase()));
    if (values.length === 1 && paymentStatusMeta[values[0]]) return paymentStatusMeta[values[0]];
    if (values.includes("for_verification")) return paymentStatusMeta.for_verification;
    if (values.includes("rejected")) return paymentStatusMeta.rejected;
    if (values.includes("balance_due")) return paymentStatusMeta.balance_due;
    if (values.includes("downpayment_paid") || values.includes("paid")) {
      return { label: "Partially paid", tone: "warning" };
    }
    return { label: "Payment status available", tone: "neutral" };
  }

  function paymentSummary(rows, paymentMeta) {
    const paymentStates = rows.map((row) => String(row.paymentStatus || "").trim().toLowerCase());
    const total = rows.reduce((sum, row) => sum + safeNumber(row.total), 0);
    const recorded = rows.reduce((sum, row) => {
      const state = String(row.paymentStatus || "").trim().toLowerCase();
      if (state === "paid") return sum + safeNumber(row.total);
      if (["downpayment_paid", "deposit_retained"].includes(state)) {
        return sum + Math.min(safeNumber(row.total), safeNumber(row.downpayment));
      }
      return sum;
    }, 0);
    const submitted = rows.reduce((sum, row) => sum + Math.min(safeNumber(row.total), safeNumber(row.downpayment)), 0);

    if (paymentStates.every((state) => state === "paid")) return `${formatCurrency(total)} paid`;
    if (paymentStates.some((state) => state === "for_verification")) return `${formatCurrency(submitted)} submitted for review`;
    if (recorded > 0) return `${formatCurrency(recorded)} recorded`;
    if (paymentMeta.label === "Payment not recorded") return "No payment recorded";
    return paymentMeta.label;
  }

  function makeStatusPill(meta, prefix) {
    const pill = element("span", `status-pill is-${meta.tone}`, `${prefix}: ${meta.label}`);
    return pill;
  }

  function makeSummaryItem(label, value) {
    const item = element("div", "summary-item");
    item.append(element("span", "summary-label", label), element("strong", "summary-value", value));
    return item;
  }

  function scheduleSortKey(row) {
    return [row.date, row.startTime, row.courtName, row.ref].map((value) => String(value || "")).join("|");
  }

  function makeScheduleItem(row) {
    const item = element("li", "schedule-item");
    item.append(
      element("strong", "schedule-court", String(row.courtName || "Court")),
      element("span", "schedule-date", formatDate(row.date)),
      element("span", "schedule-time", formatTimeRange(row)),
    );
    return item;
  }

  function displayReference(rows, requestedReference) {
    const groupRefs = unique(rows.map((row) => String(row.groupRef || "").trim()));
    if (groupRefs.length === 1) return groupRefs[0].replace(/-G$/i, "");
    const exactRow = rows.find((row) => normalizeReference(row.ref) === requestedReference);
    return String(exactRow?.ref || rows[0]?.ref || requestedReference).replace(/-G$/i, "");
  }

  function renderBooking(rows, requestedReference, wasLimited) {
    const bookingMeta = aggregateBookingStatus(rows);
    const paymentMeta = aggregatePaymentStatus(rows);
    const reference = displayReference(rows, requestedReference);
    const total = rows.reduce((sum, row) => sum + safeNumber(row.total), 0);
    const paymentMethods = naturalList(rows.map((row) => paymentMethodLabel(row.paymentMethod)));
    const isInactive = rows.every((row) => ["cancelled", "forfeited", "completed"].includes(String(row.status || "").toLowerCase()));

    const root = element("div", "booking-result");
    const header = element("div", "result-header");
    const identity = element("div");
    identity.append(
      element("p", "result-overline", rows.length > 1 ? `${rows.length} booking items` : "Booking details"),
      element("h2", "", rows.length > 1 ? "Your booking group" : "Your booking"),
      element("p", "booking-reference", reference),
    );
    const statuses = element("div", "status-stack");
    statuses.append(makeStatusPill(bookingMeta, "Booking"), makeStatusPill(paymentMeta, "Payment"));
    header.append(identity, statuses);
    root.append(header, element("p", "status-message", bookingMeta.message));

    const summary = element("div", "summary-grid");
    summary.setAttribute("aria-label", "Booking payment summary");
    summary.append(
      makeSummaryItem("Booking total", formatCurrency(total)),
      makeSummaryItem("Payment method", paymentMethods),
      makeSummaryItem("Payment summary", paymentSummary(rows, paymentMeta)),
    );
    root.append(summary);

    const scheduleSection = element("section", "schedule-section");
    scheduleSection.append(element("h3", "", rows.length > 1 ? "Booked schedules" : "Booked schedule"));
    const scheduleList = element("ul", "schedule-list");
    rows
      .slice()
      .sort((left, right) => scheduleSortKey(left).localeCompare(scheduleSortKey(right)))
      .forEach((row) => scheduleList.append(makeScheduleItem(row)));
    scheduleSection.append(scheduleList);
    root.append(scheduleSection);

    if (wasLimited) {
      root.append(element("p", "status-message", `Showing the first ${MAX_RESULT_ROWS} schedule items. Contact Paddle Rage for help with the complete booking group.`));
    }

    const policy = element("section", "booking-policy");
    if (isInactive) {
      policy.append(
        element("h3", "", "Need help with this booking?"),
        element("p", "", "Paid booking payments are final and non-refundable. This page is view-only; contact Paddle Rage if the status shown does not match your records."),
        makeContactButton(reference, "Contact Paddle Rage", "Booking status help", "reschedule-button"),
      );
    } else {
      policy.append(
        element("h3", "", "Need to change your schedule?"),
        element("p", "", "Paid booking payments are final and non-refundable. Eligible bookings may be rescheduled subject to court availability. This page does not change your booking automatically."),
        makeContactButton(reference, "Request a reschedule", "Reschedule request", "reschedule-button"),
      );
    }
    root.append(policy);

    resultRegion.replaceChildren(root);
    focusResult();
  }

  function prefillReference() {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const rawReference = fragment.get("ref") || url.searchParams.get("ref") || "";
    const reference = normalizeReference(rawReference);
    if (referenceLooksValid(reference)) refInput.value = reference;

    let removedPrivateParameter = false;
    ["email", "bookingEmail", "booking_email"].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        removedPrivateParameter = true;
      }
    });
    if (removedPrivateParameter) {
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }

  async function submitLookup(event) {
    event.preventDefault();
    clearValidation();

    const reference = normalizeReference(refInput.value);
    const email = String(emailInput.value || "").trim().toLowerCase();
    refInput.value = reference;

    if (!referenceLooksValid(reference)) {
      validationError(refInput, "Enter a Paddle Rage booking reference that starts with PB-.");
      return;
    }
    if (!emailLooksValid(email)) {
      validationError(emailInput, "Enter the valid booking email used at checkout.");
      return;
    }

    setLoading(true);
    renderLoadingState();

    try {
      if (!window.DB || typeof window.DB.getBookingForManagement !== "function") {
        const unavailable = new Error("Booking lookup is unavailable.");
        unavailable.code = "BOOKING_LOOKUP_UNAVAILABLE";
        throw unavailable;
      }

      const response = await window.DB.getBookingForManagement(reference, email);
      const allRows = Array.isArray(response) ? response.filter((row) => row && typeof row === "object") : [];
      if (!allRows.length) {
        renderMessageState({
          title: "We couldn’t find that booking",
          message: "We couldn’t find a booking matching those details. Check the booking reference and booking email, then try again.",
          reference,
        });
        return;
      }

      renderBooking(allRows.slice(0, MAX_RESULT_ROWS), reference, allRows.length > MAX_RESULT_ROWS);
    } catch (error) {
      if (String(error?.code || "") === "BOOKING_ACCESS_TOKEN_MISSING") {
        renderMessageState({
          tone: "warning",
          title: "Open this on the original browser or device",
          message: "For privacy, this booking can only be viewed in the browser and device used to complete checkout. If you changed device, changed browser, or cleared browser data, contact Paddle Rage and include your PB booking reference.",
          contact: true,
          reference,
        });
        return;
      }

      renderMessageState({
        title: "Booking lookup is temporarily unavailable",
        message: "We couldn’t securely check your booking right now. Please try again in a moment or contact Paddle Rage if you still need help.",
        contact: true,
        reference,
      });
    } finally {
      setLoading(false);
    }
  }

  function init() {
    form = document.getElementById("bookingLookupForm");
    refInput = document.getElementById("bookingRef");
    emailInput = document.getElementById("bookingEmail");
    lookupButton = document.getElementById("lookupButton");
    resultRegion = document.getElementById("bookingResult");
    formFeedback = document.getElementById("formFeedback");
    if (!form || !refInput || !emailInput || !lookupButton || !resultRegion || !formFeedback) return;

    prefillReference();
    form.addEventListener("submit", submitLookup);
    refInput.addEventListener("input", () => {
      refInput.setAttribute("aria-invalid", "false");
      formFeedback.textContent = "";
    });
    refInput.addEventListener("blur", () => {
      refInput.value = normalizeReference(refInput.value);
    });
    emailInput.addEventListener("input", () => {
      emailInput.setAttribute("aria-invalid", "false");
      formFeedback.textContent = "";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
