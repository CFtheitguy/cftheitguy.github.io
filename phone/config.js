// Linear Phone — frontend configuration
// Edit these two values to match your deployment.
window.LINEAR_PHONE_CONFIG = {
  // Base URL of your Cloudflare Worker API.
  // Recommended: map the linear-ivr worker to a custom domain (api.linearit.co)
  // so the softphone and API share a registrable domain (best for Safari/iPad).
  // You can also use the raw workers.dev URL during testing.
  API_BASE: "https://api.linearit.co",

  // Your SignalWire phone number in E.164 format (this is the caller ID for
  // outbound calls and the "From" for texts). 845-604-2025:
  MY_NUMBER: "+18456042025",

  // How often (ms) to poll for new messages / calls when the tab is open.
  POLL_INTERVAL_MS: 5000,
};
