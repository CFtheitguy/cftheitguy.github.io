// Linear Phone — frontend configuration
// Edit these two values to match your deployment.
window.LINEAR_PHONE_CONFIG = {
  // Base URL of your Cloudflare Worker API.
  // Using the worker's built-in URL (works immediately, no DNS setup).
  // If you later map the worker to a custom domain (e.g. api.linearit.co),
  // change this to that and update ALLOW_ORIGIN on the worker to match.
  API_BASE: "https://linear-ivr.friedmanchaimhersh.workers.dev",

  // Your SignalWire phone number in E.164 format (this is the caller ID for
  // outbound calls and the "From" for texts). 845-604-2025:
  MY_NUMBER: "+18456042025",

  // How often (ms) to poll for new messages / calls when the tab is open.
  POLL_INTERVAL_MS: 5000,
};
