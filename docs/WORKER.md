# Configure your Worker custom domain (api.help.linearit.co)

1) In Cloudflare → **Workers & Pages → Your Worker → Triggers → Custom Domains → Add**  
   - **Hostname:** `api.help.linearit.co`  
   - **Zone:** `linearit.co`  
   Save and let Cloudflare create the SSL cert.

2) In your Worker **Settings → Variables**, set:
   - `ALLOW_ORIGIN` = `https://help.linearit.co`

3) In `index.html` and `admin.html`, the API is already set to `https://api.help.linearit.co`.
