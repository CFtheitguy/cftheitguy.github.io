# LinearWatch — Privacy Policy (Template)

> **This is a template, not legal advice.** Replace every `[BRACKETED]` placeholder and
> have qualified counsel/DPO adapt it to the laws that apply to you and your monitored
> users (e.g., GDPR/UK GDPR, CCPA/CPRA, state and national wiretap and labor laws).

**Controller (for monitored-user data):** the Customer organization operating the
service.
**Processor / service provider:** [PROVIDER LEGAL NAME].
**Last updated:** [DATE].

---

## 1. Scope

This policy explains how data is handled in LinearWatch, a **disclosed** employee-
monitoring service used on **company-owned devices** by organizations that have
**notified and, where required, obtained consent from** the people being monitored.
LinearWatch is not intended for, and must not be used for, covert or non-consensual
monitoring.

## 2. What is collected

**From monitored devices (via the agent):**
- Periodic **screenshots** of the device's screen (the interval is set by the
  Customer; default every 120 seconds).
- Screenshot **metadata**: capture timestamp, image dimensions and size, device
  hostname, and the monitored OS username.
- **Device status**: last-seen time, consent-acknowledgment time, agent pause state.

**From dashboard administrators:**
- Account **email**, hashed password, role, and **audit records** of administrative
  actions (logins, screenshot views, settings changes, token revocations).

The agent captures screen contents only. It does not capture keystrokes, microphone,
camera, or files, and it does not hide itself — a tray indicator is visible whenever it
runs.

## 3. How it is used

Captured data is used solely to provide the monitoring service the Customer has
configured and disclosed to monitored users: storing screenshots, generating
thumbnails, displaying them to authorized administrators, and enforcing retention.
Provider does not sell captured data or use it to train models or for advertising.

## 4. Legal basis & notice (Customer responsibility)

The Customer is responsible for establishing a lawful basis for monitoring and for
notifying monitored users and obtaining any consent or approval required in the
applicable jurisdiction(s) **before** monitoring begins. The agent's first-run consent
notice records an acknowledgment timestamp, but it does **not** replace the Customer's
independent legal obligations.

## 5. Storage & security

- **Encryption in transit:** all agent uploads and dashboard traffic use TLS.
- **Screenshots at rest:** stored in private object storage (Cloudflare R2). They are
  **not public**; images are viewable only through **short-lived signed URLs** issued
  to authenticated, authorized administrators of the owning organization.
- **Passwords:** stored only as salted PBKDF2-HMAC-SHA256 hashes.
- **Device tokens:** stored only as SHA-256 hashes; each is per-device and revocable.
- **Tenant isolation:** every dashboard request is strictly scoped to the requesting
  organization; one organization can never access another's data.
- **Audit logging:** administrative access to screenshots is recorded.

## 6. Retention & deletion

Screenshots are automatically deleted after the Customer's configured retention period
(default 30 days) by a scheduled job. Customers can shorten retention or delete data at
any time. Audit logs are retained for [N] days. On account termination, Customer data
is deleted within [N] days except where retention is legally required.

## 7. Access & roles

Access is limited to the Customer's authorized users under role-based permissions
(owner/admin/viewer). Provider personnel access captured data only as needed to operate
or support the service, under confidentiality obligations.

## 8. Rights of monitored users

Depending on jurisdiction, monitored users may have rights to be informed and to access,
correct, or delete data about them, and to object to or restrict processing. Because the
Customer is the controller, such requests should be directed to the Customer, who is
responsible for responding. Provider will assist the Customer as required.

## 9. International transfers / sub-processors

Data may be processed on Cloudflare infrastructure and other listed sub-processors.
[List sub-processors, regions, and transfer mechanisms.]

## 10. Contact

Customer DPO / privacy contact: [CUSTOMER CONTACT].
Provider contact: [PROVIDER CONTACT / DPO EMAIL].

---

### Monitored-user notice (short template the Customer can adapt and post)

> This computer is **company-owned** and monitored using LinearWatch. While you are
> signed in, screenshots of this screen are captured about every **[N] seconds**,
> stored securely, retained for **[N] days**, and viewable by authorized
> administrators at **[COMPANY]**. A **monitoring indicator** is shown in the system
> tray whenever monitoring is active. If you have questions or believe monitoring is
> occurring in error, contact **[CONTACT]**. Do not use this device for personal
> matters you consider private.
