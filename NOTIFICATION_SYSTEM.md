# Notification System Documentation

Complete notification service implementation for DOMICOP with Expo Push Notifications and WebSocket real-time updates.

## Overview

The notification system supports:
- **Mobile Push Notifications** via Expo Push API
- **Real-time Admin Dashboard** updates via WebSocket
- **User Preferences** for notification types
- **Notification History** with 60-day auto-cleanup
- **Batch Sending** (up to 500 per batch)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    NOTIFICATION SERVICE                      │
├─────────────────────────────────────────────────────────────┤
│  REST API (/notifications/*)                                │
│  WebSocket Server (/ws/notifications)                      │
│  └── Mobile clients (Expo)                                 │
│  └── Admin dashboard (TanStack Start)                      │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Expo Push   │    │  WebSocket   │    │  Auto Cleanup    │
│  (Mobile)    │    │  (Real-time) │    │  (60 days)       │
└──────────────┘    └──────────────┘    └──────────────────┘
```

## Database Schema

### Tables

**notifications** (user inbox)
```sql
- id (UUID)                 -- exposed on the wire as "ntf_<uuid>"
- member_id (UUID)
- type (loan|contribution|dividend|security|meeting)
- title (text)
- body (text)
- read (boolean)
- data (jsonb)              -- event subtype etc., e.g. { "event": "loan_approved" }
- action (jsonb, nullable)  -- CTA: { "label": text, "url": in-app expo-router path }
- created_at (timestamp)
```

**notification_devices** (push token registry, multiple devices per user)
```sql
- id (UUID)
- member_id (UUID)
- token (text, UNIQUE)      -- upsert target; a token belongs to whoever registered it last
- platform (ios|android|unknown)
- device_name (text, nullable)
- created_at / updated_at (timestamp)
```

**notification_preferences**
```sql
- member_id (UUID)
- push_enabled (boolean)          -- master switch: false stops ALL push sends
- loan_enabled (boolean)
- contribution_enabled (boolean)
- dividend_enabled (boolean)
- meeting_enabled (boolean)
-- note: `security` has no column — it is server-enforced always-on
```

**notification_logs**
```sql
- id (UUID)
- recipient_id (UUID)
- type (loan|contribution|dividend|security|meeting|system)
- channel (push|websocket)
- title (text)
- body (text)
- status (pending|sent|delivered|failed)
- created_at (timestamp)
```

### Auto-Cleanup

Notifications older than 60 days are automatically deleted via database function:
```sql
SELECT cleanup_old_notifications();
```

## API Endpoints

Bearer auth, snake_case, ISO-8601 UTC timestamps. All ids on the wire are
`ntf_`-prefixed. The wire notification object:

```json
{
  "id": "ntf_9b2f...",
  "type": "loan",
  "title": "Loan approved",
  "body": "Your Business Expansion Loan has been approved.",
  "read": false,
  "created_at": "2026-07-01T09:15:00Z",
  "action": { "label": "View Details", "url": "/loans/loan-004" }
}
```

`action.url` is always an in-app expo-router path (leading slash); `action` is
nullable. `data` is included as an extra field for event subtypes.

### User Endpoints (Authenticated)

| Endpoint | Method | Request → Response |
|----------|--------|--------------------|
| `/notifications/me?page&limit` | GET | → `{ notifications: [...], meta: { page, limit, total, total_pages, unread_count } }`, newest first |
| `/notifications/{id}/read` | PATCH | empty → `{ notification, unread_count }` (idempotent) |
| `/notifications/me/read-all` | POST | empty → `{ unread_count: 0 }` |
| `/notifications/me` | DELETE | → 204 (clears all) |
| `/notifications/devices` | POST | `{ token, platform, device_name }` → 200/201 (idempotent upsert on token) |
| `/notifications/devices/unregister` | POST | `{ token }` → 204 (POST not DELETE: Expo tokens contain `[]`) |
| `/notifications/preferences` | GET | → `{ push_enabled, categories: { loan, contribution, dividend, security, meeting } }` |
| `/notifications/preferences` | PATCH | partial → full updated object; `security` is server-enforced always-true |

Unread count lives in the list meta — there is no separate endpoint; the badge
and the screen share one query. `push_enabled: false` stops push sends, but
in-app notifications are still created.

### Admin Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/notifications/broadcast` | POST | Send notification to users |

### WebSocket

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `/ws/notifications` | WebSocket | Real-time notification stream |

## Configuration

### Environment Variables

```env
# Required
EXPO_ACCESS_TOKEN=your-expo-access-token

# Optional
WS_URL=wss://api.domicop.com
REQUIRE_EMAIL_VERIFICATION=true
```

### Expo Setup

1. Get your Expo Access Token:
   - Go to https://expo.dev/accounts/[username]/settings/access-tokens
   - Create new token
   - Copy to `.env`

2. Update your Expo project ID in the mobile app:
   ```typescript
   const token = await Notifications.getExpoPushTokenAsync({
     projectId: "005a3826-e772-4bfa-8f5c-6be57a2232ca",
   });
   ```

## Usage Examples

### Sending Notifications from the Backend

`notify()` is the single entry point for domain events. One call persists the
notification to the `notifications` inbox, publishes to the recipients'
`user-<id>` WebSocket channels (and optionally `admin-notifications`), sends
Expo push (gated by user preferences), and logs delivery to
`notification_logs`.

```typescript
import { NotificationService } from './services/notificationService';

const service = NotificationService.getInstance();

await service.notify({
  userIds: ['user-id-1', 'user-id-2'],
  type: 'loan',                       // loan|contribution|dividend|security|meeting
  title: 'Loan Approved',
  body: 'Your loan application has been approved!',
  data: { event: 'loan_approved', loan_id: '123' },
  action: { label: 'View Details', url: '/loans/123' },  // optional CTA
  notifyAdmins: true,                 // also publish to admin-notifications WS channel
  pushAdmins: false,                  // also Expo-push all admins
  push: true,                         // default true
});
```

Notes:
- `type` must be one of the canonical enum values (they drive preference
  gating). Event subtypes go in `data.event`.
- Preferences gate **push only** — the inbox row and WS frame are always
  delivered so in-app history stays complete. `push_enabled` is the master
  switch; `security` notifications cannot be muted per-category.
- The push message Expo receives is
  `{ to, title, body, data: { url, notification_id, type }, channelId: "default", badge: <unread_count> }`.
  Tokens Expo reports as `DeviceNotRegistered` are pruned from
  `notification_devices` automatically.
- The service publishes via the Bun server handle wired up in `src/index.ts`
  (`setServer(app.server)` after `listen()`). This is in-process pub/sub;
  running multiple instances would require a shared broker.

Lower-level helpers `broadcastToAdmins(payload)` and
`sendToUser(userId, payload)` are still available for WS-only sends.

**Via API:**
```bash
curl -X POST https://api.domicop.com/v1/notifications/broadcast \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Meeting Tomorrow",
    "body": "Monthly meeting at 2 PM",
    "type": "meeting",
    "action": { "label": "View Announcement", "url": "/announcements" }
  }'
```
(Optionally pass `"member_ids": [...]` to target specific members; the
default is all active members.)

### Mobile App Integration

```typescript
import { registerForPushNotifications, setupNotificationHandlers } from './notifications';

// In your app initialization
useEffect(() => {
  registerForPushNotifications();
  setupNotificationHandlers();
}, []);
```

### Admin Dashboard / Web Integration

Browsers cannot set headers on WebSocket connections, so pass the Supabase
access token as a `?token=` query parameter. (Non-browser clients may use an
`Authorization: Bearer` header instead.)

```typescript
import { useEffect } from 'react';

useEffect(() => {
  const ws = new WebSocket(
    `wss://api.domicop.com/v1/ws/notifications?token=${accessToken}`
  );

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'connected') {
      console.log('Subscribed to:', data.channels);
    }
    if (data.type === 'notification') {
      // { id: "ntf_...", notification_type, title, body, data, action, timestamp }
      showToast(data.title, data.body);
    }
  };

  return () => ws.close();
}, [accessToken]);
```

Channels: every user is subscribed to `user-<their-id>`; admins additionally
receive frames published to `admin-notifications`. Frames on the user channel
include the `notifications` inbox row `id`; admin-channel frames do not.

## Testing

### Test Push Notifications

1. **Register device:**
   ```bash
   curl -X POST http://localhost:3000/v1/notifications/devices \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "platform": "android", "device_name": "Pixel 8"}'
   ```

2. **Send test notification:**
   ```bash
   curl -X POST http://localhost:3000/v1/notifications/broadcast \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"title": "Test", "body": "Hello!", "type": "meeting", "member_ids": ["your-user-id"]}'
   ```

### Test WebSocket

```bash
bunx wscat -c "ws://localhost:3000/v1/ws/notifications?token=<access-token>"
```

Or in JS:

```javascript
const ws = new WebSocket('ws://localhost:3000/v1/ws/notifications?token=' + token);
ws.onmessage = (e) => console.log(e.data);
```

## Migration

Apply the database migration:

```bash
supabase db push
```

Or manually run in SQL Editor:
```sql
-- File: supabase/migrations/20240620_notification_system.sql
-- File: supabase/migrations/20260702_notifications_v2_rest_contract.sql
--   (required — new type enum, action column, notification_devices table,
--    reshaped preferences, unread-count badge helper)
```

## Cleanup Job

The cleanup job runs automatically via database trigger. To run manually:

```bash
# Via SQL
SELECT cleanup_old_notifications();

# Via TypeScript
import { cleanupOldNotifications } from './jobs/cleanupNotifications';
await cleanupOldNotifications();
```

## Troubleshooting

### Push notifications not received

1. Check the device is registered: `SELECT * FROM notification_devices WHERE member_id = '<id>'`
2. Verify `EXPO_ACCESS_TOKEN` is set correctly
3. Check notification preferences are enabled (`push_enabled` + the category toggle)
4. Test with Expo Push Tool: https://expo.dev/notifications

### WebSocket not connecting

1. Verify token is valid and not expired
2. Check CORS settings for WebSocket
3. Ensure `ws://` or `wss://` protocol is used
4. Check browser console for errors

### Notifications not being logged

1. Check `notification_logs` table exists
2. Verify RLS policies allow inserts
3. Check service role has proper permissions

## File Structure

```
src/
├── services/
│   └── notificationService.ts    # Main notification service
├── routes/
│   ├── notifications.ts          # REST API endpoints
│   └── websocket.ts              # WebSocket routes
├── jobs/
│   └── cleanupNotifications.ts   # Cleanup job
└── index.ts                      # Main app (updated)

supabase/migrations/
└── 20240620_notification_system.sql  # Database schema

mobile-examples/
└── notifications.ts              # Mobile integration
```

## Dependencies

```bash
# Backend
bun add expo-server-sdk

# Mobile
npx expo install expo-notifications expo-device
```

## Next Steps

1. ✅ Apply database migration
2. ✅ Set `EXPO_ACCESS_TOKEN` in `.env`
3. ✅ Test push notifications on mobile
4. ✅ Test WebSocket on admin dashboard
5. ✅ Schedule cleanup job in production

## Support

For issues with:
- **Expo Push**: Check https://docs.expo.dev/push-notifications/overview/
- **WebSocket**: See Elysia WebSocket docs
- **Database**: Check Supabase logs
