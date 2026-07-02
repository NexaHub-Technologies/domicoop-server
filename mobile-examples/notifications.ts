/**
 * Expo Push Notifications Integration (notifications v2 REST contract)
 *
 * Complete implementation for handling push notifications in the Expo app.
 * Includes permission handling, device registration, tap navigation via the
 * server-provided `data.url`, and mark-as-read on tap.
 *
 * Server push payloads carry:
 *   data: { url, notification_id, type }   // url = in-app expo-router path
 *   badge: <unread count>                  // applied automatically by the OS
 *   channelId: "default"                   // must exist on Android (see below)
 *
 * @module mobile/notifications
 * @requires expo-notifications
 * @requires expo-device
 *
 * @example
 * ```typescript
 * import { registerForPushNotificationsAsync, setupNotificationHandlers } from './notifications';
 *
 * // In your app initialization (after login):
 * useEffect(() => {
 *   registerForPushNotificationsAsync();
 *   setupNotificationHandlers();
 * }, []);
 * ```
 */

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { useState, useEffect } from "react";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "https://your-api.com";

const PUSH_TOKEN_KEY = "expo_push_token";

async function authHeaders(): Promise<Record<string, string> | null> {
  const accessToken = await SecureStore.getItemAsync("access_token");
  if (!accessToken) {
    console.error("[Notifications] No access token available");
    return null;
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

/**
 * Register for push notifications and save the device to the backend.
 *
 * Requests permissions, gets the Expo push token, and registers it via
 * POST /v1/notifications/devices (idempotent upsert on token). Should be
 * called after login and on app startup.
 *
 * @returns {Promise<string | null>} Expo push token or null if failed
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  // The server sends channelId: "default" — the channel must exist on Android
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
    });
  }

  // Only physical devices can receive remote push (not simulators/emulators)
  if (!Device.isDevice) {
    console.log("[Notifications] Must use physical device for push notifications");
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("[Notifications] Permission not granted");
    return null;
  }

  try {
    const expoToken = await Notifications.getExpoPushTokenAsync({
      projectId: "005a3826-e772-4bfa-8f5c-6be57a2232ca",
    });
    const token = expoToken.data;

    await registerDevice(token);
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
    return token;
  } catch (error) {
    console.error("[Notifications] Error getting push token:", error);
    return null;
  }
}

/**
 * Register this device with the backend.
 *
 * POST /v1/notifications/devices — idempotent upsert on token (201 on first
 * registration, 200 afterwards). A token belongs to whoever registered it
 * last, so re-registering after a user switch reassigns it correctly.
 */
async function registerDevice(token: string): Promise<void> {
  const headers = await authHeaders();
  if (!headers) return;

  try {
    const response = await fetch(`${API_URL}/v1/notifications/devices`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token,
        platform: Platform.OS === "ios" ? "ios" : "android",
        device_name: Device.deviceName ?? undefined,
      }),
    });

    if (!response.ok) {
      console.error("[Notifications] Failed to register device:", await response.text());
    } else {
      console.log("[Notifications] Device registered");
    }
  } catch (error) {
    console.error("[Notifications] Error registering device:", error);
  }
}

/**
 * Unregister this device — call on logout to stop receiving push.
 *
 * POST /v1/notifications/devices/unregister (POST, not DELETE, because Expo
 * tokens contain `[]` which break URL paths).
 */
export async function unregisterDevice(): Promise<void> {
  const headers = await authHeaders();
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (!headers || !token) return;

  try {
    const response = await fetch(`${API_URL}/v1/notifications/devices/unregister`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });

    if (response.ok) {
      await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
      console.log("[Notifications] Device unregistered");
    }
  } catch (error) {
    console.error("[Notifications] Error unregistering device:", error);
  }
}

/**
 * Setup notification handlers.
 *
 * Configures foreground display and tap handling. On tap the app navigates
 * to the server-provided in-app path (`data.url`) and marks the notification
 * as read so the badge count stays accurate.
 *
 * Should be called once on app initialization.
 */
export function setupNotificationHandlers(): void {
  // How notifications display while the app is foregrounded
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  // User tapped a notification (from background or killed state)
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as {
      url?: string | null;
      notification_id?: string | null;
      type?: string;
    };

    console.log("[Notifications] User tapped notification:", data);

    if (data?.notification_id) {
      markAsRead(data.notification_id);
    }

    handleNotificationNavigation(data);
  });

  // Notification received while the app is foregrounded
  Notifications.addNotificationReceivedListener((notification) => {
    console.log("[Notifications] Received in foreground:", notification);
  });
}

/**
 * Mark a notification as read on the backend (fire-and-forget).
 *
 * PATCH /v1/notifications/{id}/read — idempotent; returns the updated
 * notification and the new unread_count.
 */
async function markAsRead(notificationId: string): Promise<void> {
  const headers = await authHeaders();
  if (!headers) return;

  try {
    const response = await fetch(
      `${API_URL}/v1/notifications/${notificationId}/read`,
      { method: "PATCH", headers },
    );
    if (response.ok) {
      const { unread_count } = await response.json();
      await Notifications.setBadgeCountAsync(unread_count);
    }
  } catch (error) {
    console.error("[Notifications] Error marking as read:", error);
  }
}

/**
 * Navigate from a notification tap.
 *
 * `data.url` is always an in-app expo-router path with a leading slash
 * (e.g. "/loans/loan-004"); fall back to a per-type screen if absent.
 */
function handleNotificationNavigation(data: {
  url?: string | null;
  type?: string;
}): void {
  if (data?.url) {
    router.push(data.url as never);
    return;
  }

  switch (data?.type) {
    case "loan":
      router.push("/loans");
      break;
    case "contribution":
    case "dividend":
      router.push("/contributions");
      break;
    case "security":
      router.push("/messages");
      break;
    case "meeting":
      router.push("/announcements");
      break;
    default:
      console.log("[Notifications] No route for type:", data?.type);
  }
}

/**
 * Hook for using notifications in React components
 *
 * @example
 * ```typescript
 * import { usePushNotifications } from './notifications';
 *
 * function MyComponent() {
 *   const { expoPushToken, notification } = usePushNotifications();
 *
 *   return (
 *     <View>
 *       <Text>Token: {expoPushToken}</Text>
 *     </View>
 *   );
 * }
 * ```
 */
export function usePushNotifications() {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);

  useEffect(() => {
    registerForPushNotificationsAsync().then((token) => {
      setExpoPushToken(token);
    });

    setupNotificationHandlers();

    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      setNotification(notification);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return { expoPushToken, notification };
}
