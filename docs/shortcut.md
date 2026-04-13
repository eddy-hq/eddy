# iOS Shortcut — Eddy share target

One Shortcut per kid's device. Appears in the iOS share sheet so they can send any YouTube link to Eddy in two taps.

## Create the Shortcut

1. Open **Shortcuts** app → tap **+** (top right)
2. Tap **Add Action** → search **"Get URLs from Input"** → add it
3. Add action → search **"Get Contents of URL"** → add it
   - Set Method: **POST**
   - Add Header: `Content-Type` = `application/json`
   - Request Body: **JSON**
     - Add field `url` → set value to **URLs** (from step 2 output)
     - Add field `user` → type the kid's display name (e.g. `Boy1`)
   - URL: `http://<M4_TAILSCALE_IP>:3737/requests`
     *(replace with actual IP from `.env` → `TAILSCALE_IP`)*
4. Add action → **Open URLs** → set URL to:
   `http://<M4_TAILSCALE_IP>:3737/request?url=[URLs]&user=Boy1`
5. Tap the Shortcut name at the top → rename to **"Eddy"**
6. Tap **Done**

## Add to share sheet

1. In Shortcuts, long-press **Eddy** → **Details**
2. Enable **Show in Share Sheet**
3. Set **Shared File Types** to **URLs** only (remove others)
4. Tap **Add to Home Screen** too if wanted

## Pin as a Favourite

In any app, tap share → scroll the second row of icons → tap **More** → find **Eddy** → tap ☆ to favourite it. It will then appear in the first row of every share sheet.

## Test it

1. Open YouTube in Safari (not the app — the app share sheet is different)
2. Tap Share → Eddy
3. The PWA should open at `/request?url=...` showing "Getting it…"
4. Within a few minutes a notification should arrive: "Ready to watch"

## Notes

- The Shortcut works from Safari, Messages, WhatsApp — anywhere with a share sheet
- The YouTube app share sheet may not expose the URL cleanly; Safari is the reliable path
- If the kid's device isn't on Tailscale the request won't reach Eddy — check Tailscale is connected
