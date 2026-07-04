import Elysia, { t } from "elysia";
import { supabaseAuth, supabase } from "@/lib/supabase";
import { authenticate } from "@/middleware/authenticate";
import { authRateLimit } from "@/middleware/rateLimiter";
import { NotificationService } from "@/services/notificationService";

/**
 * Authentication Routes
 *
 * Handles all authentication-related endpoints for the DOMICOOP platform.
 * Both admin and member users use the same authentication flow.
 * Role-based access control is enforced via middleware and RLS policies.
 *
 * @module routes/auth
 * @requires Elysia
 * @requires supabaseAuth
 * @requires authenticate
 * @requires authRateLimit
 *
 * @example
 * ```typescript
 * import { authRoutes } from './routes/auth';
 * app.use(authRoutes);
 * ```
 */
export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(authRateLimit)

  /**
   * Login with email and password
   *
   * Authenticates a user (admin or member) with their email and password.
   * Returns JWT tokens and user information including role.
   * If email verification is enabled, users must verify their email before logging in.
   *
   * @route POST /auth/login
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.email - User's email address
   * @param {string} body.password - User's password (min 8 characters)
   * @returns {Object} 200 - Success response
   * @returns {string} 200.access_token - JWT access token
   * @returns {string} 200.refresh_token - JWT refresh token
   * @returns {number} 200.expires_in - Token expiration time in seconds
   * @returns {Object} 200.user - User information
   * @returns {string} 200.user.id - User UUID
   * @returns {string} 200.user.email - User email
   * @returns {string} 200.user.role - User role ('admin' | 'member')
   * @returns {boolean} 200.user.email_verified - Whether email is verified
   * @returns {Error} 401 - Invalid credentials
   * @returns {Error} 403 - Email not verified (if REQUIRE_EMAIL_VERIFICATION=true)
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/login
   * {
   *   "email": "user@example.com",
   *   "password": "password123"
   * }
   *
   * // Success Response
   * {
   *   "access_token": "eyJhbGciOiJIUzI1NiIs...",
   *   "refresh_token": "xxx",
   *   "expires_in": 3600,
   *   "user": {
   *     "id": "uuid",
   *     "email": "user@example.com",
   *     "role": "member",
   *     "email_verified": true
   *   }
   * }
   * ```
   */
  .post(
    "/login",
    async ({ body, set }) => {
      const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email: body.email,
        password: body.password,
      });
      if (error) {
        set.status = 401;
        throw new Error(error.message);
      }

      // Check if email is verified (if required by Supabase settings)
      if (
        !data.user!.email_confirmed_at &&
        process.env.REQUIRE_EMAIL_VERIFICATION === "true"
      ) {
        set.status = 403;
        throw new Error(
          "Please verify your email before logging in. Check your inbox for the verification link.",
        );
      }

      const { data: adminRow } = await supabase
        .from("admin_profiles")
        .select("id")
        .eq("id", data.user!.id)
        .maybeSingle();

      return {
        access_token: data.session!.access_token,
        refresh_token: data.session!.refresh_token,
        expires_in: data.session!.expires_in,
        user: {
          id: data.user!.id,
          email: data.user!.email,
          role: adminRow ? "admin" : "member",
          email_verified: !!data.user!.email_confirmed_at,
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
      }),
    },
  )

  /**
   * Register new account
   *
   * Creates a new user account with email, password, and complete profile information.
   * All profile fields are collected in a single registration call.
   * Sends verification email if email confirmation is enabled.
   *
   * @route POST /auth/register
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.email - User's email address
   * @param {string} body.password - User's password (min 8 characters)
   * @param {string} body.full_name - User's full name (min 2 characters)
   * @param {string} body.phone - User's phone number
   * @param {string} body.address - User's physical address
   * @param {string} body.bank_name - Name of the user's bank
   * @param {string} body.bank_account - User's bank account number
   * @param {string} body.bank_code - Bank identification code
   * @param {string} [body.avatar_url] - Optional URL to user's profile photo
   * @param {string} [body.next_of_kin] - Optional next of kin contact information
   * @returns {Object} 200 - Success response
   * @returns {string} 200.message - Success message
   * @returns {string} 200.user_id - Created user UUID
   * @returns {string} 200.email - User email
   * @returns {Error} 400 - Validation error or email already exists
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/register
   * {
   *   "email": "newuser@example.com",
   *   "password": "password123",
   *   "full_name": "John Doe",
   *   "phone": "+1234567890",
   *   "address": "123 Main Street, City",
   *   "bank_name": "First National Bank",
   *   "bank_account": "1234567890",
   *   "bank_code": "FNB001",
   *   "avatar_url": "https://example.com/avatars/user.jpg",
   *   "next_of_kin": "Jane Doe - +0987654321"
   * }
   *
   * // Success Response
   * {
   *   "message": "Registration successful. Please check your email to verify your account.",
   *   "user_id": "uuid",
   *   "email": "newuser@example.com"
   * }
   * ```
   */
  .post(
    "/register",
    async ({ body, set }) => {
      const { data, error } = await supabaseAuth.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: {
            full_name: body.full_name,
            phone: body.phone,
            address: body.address,
            bank_name: body.bank_name,
            bank_account: body.bank_account,
            bank_code: body.bank_code,
            avatar_url: body.avatar_url,
            next_of_kin: body.next_of_kin,
          },
        },
      });

      if (error) {
        set.status = 400;
        throw new Error(error.message);
      }

      // Profile will be auto-created by database trigger with all fields

      // Surface the new pending application on the admin dashboard;
      // never let a notification failure fail registration
      NotificationService.getInstance()
        .notify({
          userIds: [],
          type: "security",
          title: "New member application",
          body: `${body.full_name} has registered and is awaiting approval.`,
          data: { event: "member_registered", member_id: data.user!.id },
          notifyAdmins: true,
          pushAdmins: true,
        })
        .catch((err) => console.error("Failed to notify admins of registration:", err));

      return {
        message:
          "Registration successful. Please check your email to verify your account.",
        user_id: data.user!.id,
        email: data.user!.email,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
        full_name: t.String({ minLength: 2 }),
        phone: t.String(),
        address: t.String(),
        bank_name: t.String(),
        bank_account: t.String(),
        bank_code: t.String(),
        avatar_url: t.Optional(t.String()),
        next_of_kin: t.Optional(t.String()),
      }),
    },
  )

  /**
   * Refresh access token
   *
   * Refreshes an expired access token using a valid refresh token.
   * Returns new access and refresh tokens.
   *
   * @route POST /auth/refresh
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.refresh_token - Valid refresh token
   * @returns {Object} 200 - Success response with new tokens
   * @returns {string} 200.access_token - New JWT access token
   * @returns {string} 200.refresh_token - New JWT refresh token
   * @returns {number} 200.expires_in - Token expiration time in seconds
   * @returns {Error} 401 - Invalid or expired refresh token
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/refresh
   * {
   *   "refresh_token": "xxx"
   * }
   *
   * // Success Response
   * {
   *   "access_token": "eyJhbGciOiJIUzI1NiIs...",
   *   "refresh_token": "xxx",
   *   "expires_in": 3600
   * }
   * ```
   */
  .post(
    "/refresh",
    async ({ body, set }) => {
      const { data, error } = await supabaseAuth.auth.refreshSession({
        refresh_token: body.refresh_token,
      });
      if (error) {
        set.status = 401;
        throw new Error(error.message);
      }
      return {
        access_token: data.session!.access_token,
        refresh_token: data.session!.refresh_token,
        expires_in: data.session!.expires_in,
      };
    },
    { body: t.Object({ refresh_token: t.String() }) },
  )

  /**
   * Logout user
   *
   * Signs out the user and invalidates their session token.
   * Client should also clear stored tokens after calling this endpoint.
   *
   * @route POST /auth/logout
   * @group Authentication
   * @param {Object} headers - Request headers
   * @param {string} headers.authorization - Bearer token
   * @returns {Object} 200 - Success response
   * @returns {boolean} 200.success - Always true
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/logout
   * Authorization: Bearer <token>
   *
   * // Success Response
   * {
   *   "success": true
   * }
   * ```
   */
  .post("/logout", async ({ headers }) => {
    const token = headers["authorization"]?.replace("Bearer ", "");
    if (token) await supabaseAuth.auth.admin.signOut(token);
    return { success: true };
  })

  /**
   * Request password reset
   *
   * Sends a password reset email to the specified address.
   * Always returns success to prevent email enumeration attacks.
   *
   * @route POST /auth/reset-password
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.email - User's email address
   * @returns {Object} 200 - Success response (even if email doesn't exist)
   * @returns {string} 200.message - Success message
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/reset-password
   * {
   *   "email": "user@example.com"
   * }
   *
   * // Success Response (same regardless of email existence)
   * {
   *   "message": "If that email is registered, a reset link has been sent."
   * }
   * ```
   */
  .post(
    "/reset-password",
    async ({ body }) => {
      await supabaseAuth.auth.resetPasswordForEmail(body.email, {
        redirectTo: `${process.env.API_BASE_URL}/auth/confirm-reset`,
      });
      // Always return success — never leak whether email exists
      return { message: "If that email is registered, a reset link has been sent." };
    },
    { body: t.Object({ email: t.String({ format: "email" }) }) },
  )

  /**
   * Confirm password reset
   *
   * Sets a new password after the user clicks the reset link in their email.
   * The token from the email URL must be included in the Authorization header.
   *
   * @route POST /auth/confirm-reset
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.password - New password (min 8 characters)
   * @returns {Object} 200 - Success response
   * @returns {boolean} 200.success - Always true
   * @returns {Error} 400 - Invalid token or weak password
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/confirm-reset
   * Authorization: Bearer <reset-token-from-email>
   * {
   *   "password": "newpassword123"
   * }
   *
   * // Success Response
   * {
   *   "success": true
   * }
   * ```
   */
  .post(
    "/confirm-reset",
    async ({ body, set }) => {
      const { error } = await supabaseAuth.auth.updateUser({ password: body.password });
      if (error) {
        set.status = 400;
        throw new Error(error.message);
      }
      return { success: true };
    },
    { body: t.Object({ password: t.String({ minLength: 8 }) }) },
  )

  /**
   * Resend email verification
   *
   * Resends the verification email to the specified address.
   * Useful if the user didn't receive the original email.
   *
   * @route POST /auth/resend-verification
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.email - User's email address
   * @returns {Object} 200 - Success response
   * @returns {string} 200.message - Success message
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/resend-verification
   * {
   *   "email": "user@example.com"
   * }
   *
   * // Success Response
   * {
   *   "message": "Verification email resent. Please check your inbox."
   * }
   * ```
   */
  .post(
    "/resend-verification",
    async ({ body }) => {
      await supabaseAuth.auth.resend({
        type: "signup",
        email: body.email,
      });
      return { message: "Verification email resent. Please check your inbox." };
    },
    { body: t.Object({ email: t.String({ format: "email" }) }) },
  )

  /**
   * Login with Google OAuth
   *
   * Authenticates a user via Google ID token obtained from native Google Sign-In.
   * The client obtains the ID token natively (using @react-native-google-signin/google-signin)
   * and sends it to this endpoint. Supabase verifies the token and creates/returns the session.
   * Auto-creates a profile via the database trigger if the user is new.
   *
   * @route POST /auth/oauth/google
   * @group Authentication
   * @param {Object} body - Request body
   * @param {string} body.id_token - Google ID token from native Google Sign-In
   * @param {string} [body.nonce] - Optional nonce for token verification
   * @returns {Object} 200 - Success response
   * @returns {string} 200.access_token - JWT access token
   * @returns {string} 200.refresh_token - JWT refresh token
   * @returns {number} 200.expires_in - Token expiration time in seconds
   * @returns {Object} 200.user - User information
   * @returns {string} 200.user.id - User UUID
   * @returns {string} 200.user.email - User email
   * @returns {string} 200.user.role - User role ('admin' | 'member')
   * @returns {boolean} 200.user.email_verified - Whether email is verified
   * @returns {Error} 401 - Invalid Google token
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/oauth/google
   * {
   *   "id_token": "eyJhbGciOiJSUzI1NiIs...",
   *   "nonce": "optional-nonce"
   * }
   *
   * // Success Response
   * {
   *   "access_token": "eyJhbGciOiJIUzI1NiIs...",
   *   "refresh_token": "xxx",
   *   "expires_in": 3600,
   *   "user": {
   *     "id": "uuid",
   *     "email": "user@gmail.com",
   *     "role": "member",
   *     "email_verified": true
   *   }
   * }
   * ```
   */
  .post(
    "/oauth/google",
    async ({ body, set }) => {
      const { data, error } = await supabaseAuth.auth.signInWithIdToken({
        provider: "google",
        token: body.id_token,
        nonce: body.nonce,
      });

      if (error) {
        set.status = 401;
        throw new Error(error.message);
      }

      // Google sign-ins are members; admin status still comes from admin_profiles
      const { data: adminRow } = await supabase
        .from("admin_profiles")
        .select("id")
        .eq("id", data.user.id)
        .maybeSingle();

      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        user: {
          id: data.user.id,
          email: data.user.email,
          role: adminRow ? "admin" : "member",
          email_verified: !!data.user.email_confirmed_at,
        },
      };
    },
    {
      body: t.Object({
        id_token: t.String(),
        nonce: t.Optional(t.String()),
      }),
    },
  )

  /**
   * Authenticated routes middleware
   *
   * All routes after this point require a valid JWT token in the Authorization header.
   * The authenticate middleware validates the token and adds user context.
   */
  .use(authenticate)

  /**
   * Link Google account to existing user
   *
   * Links a Google OAuth identity to an existing email/password account.
   * Requires the user to be authenticated. After linking, the user can
   * log in with either email/password or Google.
   *
   * @route POST /auth/link/google
   * @group Authentication
   * @security Bearer
   * @param {Object} body - Request body
   * @param {string} body.id_token - Google ID token from native Google Sign-In
   * @param {string} [body.nonce] - Optional nonce for token verification
   * @returns {Object} 200 - Success response
   * @returns {boolean} 200.success - Always true
   * @returns {string} 200.message - Success message
   * @returns {Error} 400 - Failed to link account
   * @returns {Error} 401 - Unauthorized (invalid or missing token)
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/link/google
   * Authorization: Bearer <token>
   * {
   *   "id_token": "eyJhbGciOiJSUzI1NiIs...",
   *   "nonce": "optional-nonce"
   * }
   *
   * // Success Response
   * {
   *   "success": true,
   *   "message": "Google account linked successfully"
   * }
   * ```
   */
  .post(
    "/link/google",
    async ({ body, set }) => {
      const { error } = await supabaseAuth.auth.linkIdentity({
        provider: "google",
        token: body.id_token,
        nonce: body.nonce,
      });

      if (error) {
        set.status = 400;
        throw new Error(error.message);
      }

      return { success: true, message: "Google account linked successfully" };
    },
    {
      body: t.Object({
        id_token: t.String(),
        nonce: t.Optional(t.String()),
      }),
    },
  )

  /**
   * Change password
   *
   * Changes the user's password. Requires the current password for verification.
   * Both admin and member users can use this endpoint.
   *
   * @route POST /auth/change-password
   * @group Authentication
   * @security Bearer
   * @param {Object} body - Request body
   * @param {string} body.current_password - Current password
   * @param {string} body.new_password - New password (min 8 characters)
   * @returns {Object} 200 - Success response
   * @returns {boolean} 200.success - Always true
   * @returns {string} 200.message - Success message
   * @returns {Error} 401 - Current password is incorrect
   * @returns {Error} 400 - New password doesn't meet requirements
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/change-password
   * Authorization: Bearer <token>
   * {
   *   "current_password": "oldpassword123",
   *   "new_password": "newpassword123"
   * }
   *
   * // Success Response
   * {
   *   "success": true,
   *   "message": "Password changed successfully"
   * }
   * ```
   */
  .post(
    "/change-password",
    async ({ body, set, user }) => {
      // First verify current password
      const { error: verifyError } = await supabaseAuth.auth.signInWithPassword({
        email: user!.email!,
        password: body.current_password,
      });

      if (verifyError) {
        set.status = 401;
        throw new Error("Current password is incorrect");
      }

      // Then update to new password
      const { error } = await supabaseAuth.auth.updateUser({
        password: body.new_password,
      });

      if (error) {
        set.status = 400;
        throw new Error(error.message);
      }
      return { success: true, message: "Password changed successfully" };
    },
    {
      body: t.Object({
        current_password: t.String({ minLength: 8 }),
        new_password: t.String({ minLength: 8 }),
      }),
    },
  )

  /**
   * Store Expo Push Token
   *
   * Stores the Expo Push Notification token for push notifications.
   * Should be called after login or when the token changes.
   * Both admin and member users can receive push notifications.
   *
   * @route POST /auth/expo-token
   * @group Authentication
   * @security Bearer
   * @param {Object} body - Request body
   * @param {string} body.expo_push_token - Expo Push Token
   * @returns {Object} 200 - Success response
   * @returns {boolean} 200.success - Always true
   * @returns {Error} 401 - Unauthorized (invalid or missing token)
   *
   * @example
   * ```typescript
   * // Request
   * POST /auth/expo-token
   * Authorization: Bearer <token>
   * {
   *   "expo_push_token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
   * }
   *
   * // Success Response
   * {
   *   "success": true
   * }
   * ```
   */
  .post(
    "/expo-token",
    async ({ userId, body }) => {
      await supabase
        .from("profiles")
        .update({ expo_push_token: body.expo_push_token })
        .eq("id", userId!);
      // Push delivery reads from notification_devices — mirror the token
      // there so app builds still using this legacy endpoint keep working.
      // New builds should use POST /notifications/devices instead.
      await supabase.from("notification_devices").upsert(
        {
          member_id: userId!,
          token: body.expo_push_token,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "token" },
      );
      return { success: true };
    },
    { body: t.Object({ expo_push_token: t.String() }) },
  );
