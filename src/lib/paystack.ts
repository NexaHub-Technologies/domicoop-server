/**
 * Paystack API Client
 *
 * Provides typed methods for interacting with Paystack's API including:
 * - Transaction initialization and verification
 * - Bank listing and account verification
 * - Transfer recipients management
 * - Fund transfers (disbursements)
 * - Webhook event handling
 *
 * @module lib/paystack
 * @requires environment PAYSTACK_SECRET_KEY
 *
 * @example
 * ```typescript
 * import { paystack } from './lib/paystack';
 *
 * // Initialize a payment transaction
 * const transaction = await paystack.initializeTransaction({
 *   email: 'customer@example.com',
 *   amount: 50000,
 *   reference: 'REF-' + Date.now()
 * });
 * ```
 */

const BASE = process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co";
const SECRET = process.env.PAYSTACK_SECRET_KEY!;

/**
 * Response from initializing a Paystack transaction
 */
export interface PaystackInitializeResponse {
  /** URL to redirect customer for payment */
  authorization_url: string;
  /** Access code for the transaction */
  access_code: string;
  /** Unique reference for the transaction */
  reference: string;
}

/**
 * Full transaction verification response from Paystack
 */
export interface PaystackVerifyResponse {
  status: string;
  message: string;
  data: {
    id: number;
    domain: string;
    status: string;
    reference: string;
    amount: number;
    message: string | null;
    gateway_response: string;
    paid_at: string;
    created_at: string;
    channel: string;
    currency: string;
    ip_address: string;
    metadata: Record<string, unknown>;
    log: {
      time_spent: number;
      attempts: number;
      authentication: string;
      errors: number;
      success: boolean;
      mobile: boolean;
      input: unknown[];
      channel: string | null;
      history: {
        type: string;
        message: string;
        time: number;
      }[];
    };
    fees: number | null;
    fees_split: unknown | null;
    authorization: {
      authorization_code: string;
      bin: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      channel: string;
      card_type: string;
      bank: string;
      country_code: string;
      brand: string;
      reusable: boolean;
      signature: string;
      account_name: string | null;
    };
    customer: {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string;
      customer_code: string;
      phone: string | null;
      metadata: Record<string, unknown> | null;
      risk_action: string;
    };
    plan: unknown | null;
    split: unknown;
    order_id: string | null;
    paidAt: string;
    createdAt: string;
    requested_amount: number;
    source: {
      type: string;
      source: string;
      entry_point: string;
      identifier: string | null;
    };
  };
}

/**
 * Bank information from Paystack
 */
export interface PaystackBank {
  /** Unique bank identifier */
  id: number;
  /** Bank name */
  name: string;
  /** URL-friendly bank slug */
  slug: string;
  /** Bank code (used for transfers) */
  code: string;
  /** Bank longcode for direct debits */
  longcode: string;
  /** Payment gateway provider */
  gateway: string | null;
  /** Whether bank supports direct bank payments */
  pay_with_bank: boolean;
  /** Whether bank supports bank transfers */
  pay_with_bank_transfer: boolean;
  /** Whether bank is active */
  active: boolean;
  /** Whether bank is deleted */
  is_deleted: boolean;
  /** Country where bank operates */
  country: string;
  /** Currency code (e.g., NGN, GHS) */
  currency: string;
  /** Bank account type */
  type: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Response from listing banks
 */
export interface PaystackBankListResponse {
  /** Array of bank objects */
  data: PaystackBank[];
  /** Pagination metadata */
  meta: {
    total: number;
    skipped: number;
    perPage: number;
    page: number;
    pageCount: number;
  };
}

/**
 * Account verification result
 */
export interface PaystackAccountVerification {
  /** Bank account number */
  account_number: string;
  /** Account holder's name */
  account_name: string;
  /** Bank code */
  bank_code: string;
  /** Bank name */
  bank_name: string;
}

/**
 * Details of a transfer recipient's bank account
 */
export interface TransferRecipientDetails {
  /** Card authorization code (if applicable) */
  authorization_code: string | null;
  /** Bank account number */
  account_number: string;
  /** Account holder name (if verified) */
  account_name: string | null;
  /** Bank code */
  bank_code: string;
  /** Bank name */
  bank_name: string;
}

/**
 * Transfer recipient object
 */
export interface PaystackTransferRecipient {
  /** Whether recipient is active */
  active: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Currency code */
  currency: string;
  /** Environment domain (test/live) */
  domain: string;
  /** Paystack internal ID */
  id: number;
  /** Integration ID */
  integration: number;
  /** Recipient's name */
  name: string;
  /** Unique recipient code for transfers */
  recipient_code: string;
  /** Recipient type (nuban, ghipss, mobile_money, basa) */
  type: "nuban" | "ghipss" | "mobile_money" | "basa";
  /** Last update timestamp */
  updatedAt: string;
  /** Whether recipient is deleted */
  is_deleted: boolean;
  /** Bank account details */
  details: TransferRecipientDetails;
}

/**
 * Transfer status values
 */
export type TransferStatus = "pending" | "success" | "failed";

/**
 * Transfer object from Paystack
 */
export interface PaystackTransfer {
  /** Transfer session IDs */
  transfersessionid: string[];
  /** Transfer trial IDs */
  transfertrials: string[];
  /** Environment domain (test/live) */
  domain: string;
  /** Transfer amount in smallest currency unit */
  amount: number;
  /** Currency code */
  currency: string;
  /** Unique transfer reference */
  reference: string;
  /** Source of funds (e.g., 'balance') */
  source: string;
  /** Source details */
  source_details: null;
  /** Transfer reason/narration */
  reason: string;
  /** Current transfer status */
  status: TransferStatus;
  /** Failure details if any */
  failures: null;
  /** Unique transfer code */
  transfer_code: string;
  /** Titan code if applicable */
  titan_code: null;
  /** Timestamp when transfer completed */
  transferred_at: null;
  /** Paystack internal transfer ID */
  id: number;
  /** Integration ID */
  integration: number;
  /** Request ID */
  request: number;
  /** Recipient ID */
  recipient: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Transfer event data from webhooks
 */
export interface PaystackTransferEventData {
  /** Transfer amount in kobo/pesewas */
  amount: number;
  /** Creation timestamp */
  createdAt: string;
  /** Currency code */
  currency: string;
  /** Environment domain (test/live) */
  domain: string;
  /** Failure details if any */
  failures: null;
  /** Paystack internal transfer ID */
  id: number;
  /** Integration ID */
  integration: number;
  /** Transfer reason/narration */
  reason: string;
  /** Unique transfer reference */
  reference: string;
  /** Source of funds */
  source: string;
  /** Source details */
  source_details: null;
  /** Transfer status */
  status: TransferStatus;
  /** Titan code */
  titan_code: null;
  /** Unique transfer code */
  transfer_code: string;
  /** Request ID */
  request: number;
  /** Timestamp when transfer completed */
  transferred_at: null;
  /** Last update timestamp */
  updatedAt: string;
  /** Recipient information */
  recipient: {
    /** Whether recipient is active */
    active: boolean;
    /** Creation timestamp */
    createdAt: string;
    /** Currency code */
    currency: string;
    /** Description */
    description: string;
    /** Environment domain */
    domain: string;
    /** Recipient email */
    email: string | null;
    /** Recipient ID */
    id: number;
    /** Integration ID */
    integration: number;
    /** Custom metadata */
    metadata: Record<string, unknown> | null;
    /** Recipient name */
    name: string;
    /** Unique recipient code */
    recipient_code: string;
    /** Recipient type */
    type: string;
    /** Last update timestamp */
    updatedAt: string;
    /** Whether deleted */
    is_deleted: boolean;
    /** Alias for is_deleted */
    isDeleted: boolean;
    /** Bank account details */
    details: TransferRecipientDetails;
  };
  /** Session information */
  session: {
    /** Provider */
    provider: string | null;
    /** Session ID */
    id: string | null;
  };
  /** Fee charged for transfer */
  fee_charged: number;
  /** Fees breakdown */
  fees_breakdown: null;
  /** Gateway response */
  gateway_response: null;
}

/**
 * Paystack webhook event
 */
export interface PaystackTransferEvent {
  /** Event type (e.g., 'transfer.success') */
  event: string;
  /** Event payload data */
  data: PaystackTransferEventData;
}

/**
 * Internal request handler for Paystack API
 *
 * @param path - API endpoint path
 * @param options - Fetch request options
 * @returns Parsed response data
 * @throws Error if Paystack returns unsuccessful response
 */
async function paystackRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!json.status) throw new Error(json.message);
  return json.data;
}

/**
 * Paystack API Client
 *
 * Typed methods for all Paystack operations used in DOMICOP:
 * - Payment transactions (collection)
 * - Bank listing and account verification
 * - Transfer recipients and disbursements
 *
 * @example
 * ```typescript
 * // Verify member's bank account before disbursement
 * const account = await paystack.resolveAccount('0123456789', '044');
 * console.log(account.account_name); // 'JOHN DOE'
 *
 * // Create recipient and initiate transfer
 * const recipient = await paystack.createTransferRecipient({
 *   name: 'John Doe',
 *   account_number: '0123456789',
 *   bank_code: '044'
 * });
 *
 * const transfer = await paystack.initiateTransfer({
 *   amount: 50000, // ₦500 in kobo
 *   recipient: recipient.recipient_code,
 *   reference: 'LOAN-abc123',
 *   reason: 'Loan disbursement'
 * });
 * ```
 */
export const paystack = {
  /**
   * Initialize a payment transaction
   *
   * Creates a payment session and returns an authorization URL
   * where the customer can complete payment.
   *
   * @param payload - Transaction parameters
   * @param payload.email - Customer's email address
   * @param payload.amount - Amount in Naira (converted to kobo internally)
   * @param payload.reference - Unique transaction reference
   * @param payload.metadata - Optional custom metadata
   * @param payload.callback_url - Optional redirect URL after payment
   * @returns Authorization URL, access code, and reference
   *
   * @example
   * ```typescript
   * const result = await paystack.initializeTransaction({
   *   email: 'member@email.com',
   *   amount: 50000,
   *   reference: 'CONTRIB-123456',
   *   metadata: { member_id: 'uuid', type: 'contribution' }
   * });
   * // Returns: { authorization_url, access_code, reference }
   * ```
   */
  initializeTransaction: (payload: {
    email: string;
    amount: number;
    reference: string;
    metadata?: Record<string, unknown>;
    callback_url?: string;
  }): Promise<PaystackInitializeResponse> =>
    paystackRequest<PaystackInitializeResponse>("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        amount: payload.amount * 100,
      }),
    }),

  /**
   * Verify a transaction by reference
   *
   * Checks the status of a previously initialized transaction.
   *
   * @param reference - The transaction reference to verify
   * @returns Full transaction details including status, customer info, and payment data
   *
   * @example
   * ```typescript
   * const result = await paystack.verifyTransaction('CONTRIB-123456');
   * if (result.status === 'success') {
   *   console.log('Payment verified:', result.amount, result.currency);
   * }
   * ```
   */
  verifyTransaction: (reference: string): Promise<PaystackVerifyResponse["data"]> =>
    paystackRequest<PaystackVerifyResponse["data"]>(`/transaction/verify/${reference}`),

  /**
   * List available banks
   *
   * Fetches the list of banks supported by Paystack for Nigeria (NGN currency).
   * Use this to populate bank selection dropdowns for members.
   *
   * @param params - Optional filter parameters
   * @param params.perPage - Number of results per page (max 100)
   * @param params.page - Page number
   * @returns List of banks with pagination metadata
   *
   * @example
   * ```typescript
   * // Get Nigerian banks
   * const banks = await paystack.listBanks();
   * banks.data.forEach(bank => console.log(bank.name, bank.code));
   * ```
   */
  listBanks: (params?: {
    perPage?: number;
    page?: number;
  }): Promise<PaystackBankListResponse> => {
    const query = new URLSearchParams();
    query.set("currency", "NGN");
    if (params?.perPage) query.set("perPage", params.perPage.toString());
    if (params?.page) query.set("page", params.page.toString());
    const queryString = query.toString();
    return paystackRequest<PaystackBankListResponse>(`/bank?${queryString}`);
  },

  /**
   * Verify a bank account number
   *
   * Resolves an account number to get the account holder's name.
   * Use this to validate member bank details before creating recipients.
   *
   * @param accountNumber - Bank account number
   * @param bankCode - Bank code (from listBanks)
   * @returns Account holder name, account number, bank code, and bank name
   *
   * @example
   * ```typescript
   * const verification = await paystack.resolveAccount('0123456789', '044');
   * console.log(verification.account_name); // 'JOHN DOE'
   * console.log(verification.bank_name); // 'Access Bank'
   * ```
   */
  resolveAccount: (
    accountNumber: string,
    bankCode: string,
  ): Promise<PaystackAccountVerification> =>
    paystackRequest<PaystackAccountVerification>(
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    ),

  /**
   * Create a transfer recipient
   *
   * Creates a reusable recipient entity for sending money to a bank account.
   * A duplicate account number returns the existing recipient.
   *
   * @param payload - Recipient parameters
   * @param payload.name - Recipient's name
   * @param payload.account_number - Bank account number
   * @param payload.bank_code - Bank code
   * @param payload.currency - Currency code (defaults to NGN)
   * @param payload.type - Recipient type (defaults to nuban)
   * @returns The created recipient's code
   *
   * @example
   * ```typescript
   * const recipient = await paystack.createTransferRecipient({
   *   name: 'John Doe',
   *   account_number: '0123456789',
   *   bank_code: '044'
   * });
   * // Returns: { recipient_code: 'RCP_xxxxx' }
   * // Save recipient_code to member profile for future transfers
   * ```
   */
  createTransferRecipient: (payload: {
    name: string;
    account_number: string;
    bank_code: string;
    currency?: string;
    type?: string;
  }): Promise<{ recipient_code: string }> =>
    paystackRequest<{ recipient_code: string }>("/transferrecipient", {
      method: "POST",
      body: JSON.stringify({
        type: "nuban",
        currency: "NGN",
        ...payload,
      }),
    }),

  /**
   * Initiate a fund transfer
   *
   * Sends money from your Paystack balance to a recipient.
   * Amount is converted to kobo internally.
   *
   * @param payload - Transfer parameters
   * @param payload.source - Source of funds (defaults to 'balance')
   * @param payload.amount - Amount in Naira (converted to kobo)
   * @param payload.recipient - Recipient code from createTransferRecipient
   * @param payload.reference - Unique transfer reference
   * @param payload.reason - Transfer narration
   * @param payload.currency - Currency code (defaults to NGN)
   * @returns Transfer code, reference, and status
   *
   * @example
   * ```typescript
   * const transfer = await paystack.initiateTransfer({
   *   amount: 50000, // ₦50,000
   *   recipient: 'RCP_xxxxx',
   *   reference: 'LOAN-abc123-1700000000000',
   *   reason: 'Loan disbursement for John Doe'
   * });
   *
   * if (transfer.status === 'success') {
   *   console.log('Transfer completed:', transfer.transfer_code);
   * } else if (transfer.status === 'pending') {
   *   console.log('Awaiting OTP confirmation');
   * }
   * ```
   */
  initiateTransfer: (payload: {
    source?: string;
    amount: number;
    recipient: string;
    reference?: string;
    reason?: string;
    currency?: string;
  }): Promise<{ transfer_code: string; reference: string; status: TransferStatus }> =>
    paystackRequest<{ transfer_code: string; reference: string; status: TransferStatus }>(
      "/transfer",
      {
        method: "POST",
        body: JSON.stringify({
          source: "balance",
          currency: "NGN",
          ...payload,
          amount: payload.amount * 100,
        }),
      },
    ),

  /**
   * Verify a transfer by reference
   *
   * Checks the current status of a transfer.
   *
   * @param reference - The transfer reference
   * @returns Full transfer details including status
   *
   * @example
   * ```typescript
   * const transfer = await paystack.verifyTransfer('LOAN-abc123-1700000000000');
   * console.log(transfer.status); // 'success', 'pending', or 'failed'
   * ```
   */
  verifyTransfer: (reference: string): Promise<PaystackTransferEventData> =>
    paystackRequest<PaystackTransferEventData>(`/transfer/verify/${reference}`),

  /**
   * Finalize a transfer requiring OTP
   *
   * Completes a transfer that was initiated but requires OTP verification.
   *
   * @param payload - Finalization parameters
   * @param payload.transfer_code - The transfer code from initiateTransfer
   * @param payload.otp - One-time password from phone/SMS
   * @returns Updated transfer object
   *
   * @example
   * ```typescript
   * const result = await paystack.finalizeTransfer({
   *   transfer_code: 'TRF_xxxxx',
   *   otp: '123456'
   * });
   * ```
   */
  finalizeTransfer: (payload: {
    transfer_code: string;
    otp: string;
  }): Promise<PaystackTransfer> =>
    paystackRequest<PaystackTransfer>("/transfer/finalize_transfer", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /**
   * List transfers
   *
   * Fetches a paginated list of transfers on your integration.
   *
   * @param params - Optional filter parameters
   * @param params.perPage - Number of results per page
   * @param params.page - Page number
   * @param params.status - Filter by transfer status
   * @returns List of transfers with pagination metadata
   *
   * @example
   * ```typescript
   * // Get all successful transfers
   * const transfers = await paystack.listTransfers({ status: 'success' });
   * transfers.data.forEach(t => console.log(t.reference, t.amount));
   * ```
   */
  listTransfers: (params?: {
    perPage?: number;
    page?: number;
    status?: TransferStatus;
  }): Promise<{
    data: PaystackTransfer[];
    meta: { total: number; perPage: number; page: number; pageCount: number };
  }> => {
    const query = new URLSearchParams();
    if (params?.perPage) query.set("perPage", params.perPage.toString());
    if (params?.page) query.set("page", params.page.toString());
    if (params?.status) query.set("status", params.status);
    const queryString = query.toString();
    return paystackRequest<{
      data: PaystackTransfer[];
      meta: { total: number; perPage: number; page: number; pageCount: number };
    }>(`/transfer${queryString ? `?${queryString}` : ""}`);
  },
};
