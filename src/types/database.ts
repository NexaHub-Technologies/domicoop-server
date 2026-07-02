export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      announcements: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          published: boolean
          title: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          published?: boolean
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          published?: boolean
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity: string
          entity_id: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contributions: {
        Row: {
          amount: number
          created_at: string
          deposit: number | null
          id: string
          member_email: string | null
          member_id: string
          member_no: string | null
          month: string
          notes: string | null
          payment_method: string | null
          payment_status: string | null
          savings: number | null
          shares: number | null
          social: number | null
          transaction_ref: string | null
          updated_at: string
          year: number
        }
        Insert: {
          amount: number
          created_at?: string
          deposit?: number | null
          id?: string
          member_email?: string | null
          member_id: string
          member_no?: string | null
          month: string
          notes?: string | null
          payment_method?: string | null
          payment_status?: string | null
          savings?: number | null
          shares?: number | null
          social?: number | null
          transaction_ref?: string | null
          updated_at?: string
          year: number
        }
        Update: {
          amount?: number
          created_at?: string
          deposit?: number | null
          id?: string
          member_email?: string | null
          member_id?: string
          member_no?: string | null
          month?: string
          notes?: string | null
          payment_method?: string | null
          payment_status?: string | null
          savings?: number | null
          shares?: number | null
          social?: number | null
          transaction_ref?: string | null
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "contributions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dividends: {
        Row: {
          amount: number
          created_at: string
          id: string
          member_id: string
          paystack_transfer_ref: string | null
          status: string
          year: number
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          member_id: string
          paystack_transfer_ref?: string | null
          status?: string
          year: number
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          member_id?: string
          paystack_transfer_ref?: string | null
          status?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "dividends_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      loans: {
        Row: {
          admin_notes: string | null
          amount_approved: number | null
          amount_requested: number
          balance: number | null
          created_at: string
          disbursed_at: string | null
          disbursement_pending_otp: boolean | null
          due_date: string | null
          id: string
          interest_rate: number | null
          member_id: string
          monthly_repayment: number | null
          paystack_transfer_ref: string | null
          purpose: string
          recipient_code: string | null
          status: string
          tenure_months: number | null
          type: string
          updated_at: string
        }
        Insert: {
          admin_notes?: string | null
          amount_approved?: number | null
          amount_requested: number
          balance?: number | null
          created_at?: string
          disbursed_at?: string | null
          disbursement_pending_otp?: boolean | null
          due_date?: string | null
          id?: string
          interest_rate?: number | null
          member_id: string
          monthly_repayment?: number | null
          paystack_transfer_ref?: string | null
          purpose: string
          recipient_code?: string | null
          status?: string
          tenure_months?: number | null
          type: string
          updated_at?: string
        }
        Update: {
          admin_notes?: string | null
          amount_approved?: number | null
          amount_requested?: number
          balance?: number | null
          created_at?: string
          disbursed_at?: string | null
          disbursement_pending_otp?: boolean | null
          due_date?: string | null
          id?: string
          interest_rate?: number | null
          member_id?: string
          monthly_repayment?: number | null
          paystack_transfer_ref?: string | null
          purpose?: string
          recipient_code?: string | null
          status?: string
          tenure_months?: number | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loans_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      message_replies: {
        Row: {
          body: string
          created_at: string
          id: string
          message_id: string
          sender_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          message_id: string
          sender_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          message_id?: string
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_replies_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_replies_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          created_at: string
          id: string
          member_id: string
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          member_id: string
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          member_id?: string
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_devices: {
        Row: {
          created_at: string
          device_name: string | null
          id: string
          member_id: string
          platform: string
          token: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          device_name?: string | null
          id?: string
          member_id: string
          platform?: string
          token: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          device_name?: string | null
          id?: string
          member_id?: string
          platform?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_devices_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_logs: {
        Row: {
          body: string
          channel: string
          created_at: string | null
          data: Json | null
          delivered_at: string | null
          error_message: string | null
          id: string
          recipient_id: string | null
          status: string | null
          title: string
          type: string
        }
        Insert: {
          body: string
          channel: string
          created_at?: string | null
          data?: Json | null
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          recipient_id?: string | null
          status?: string | null
          title: string
          type: string
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string | null
          data?: Json | null
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          recipient_id?: string | null
          status?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_logs_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          contribution_enabled: boolean
          dividend_enabled: boolean
          id: string
          loan_enabled: boolean
          meeting_enabled: boolean
          member_id: string | null
          push_enabled: boolean
          updated_at: string | null
        }
        Insert: {
          contribution_enabled?: boolean
          dividend_enabled?: boolean
          id?: string
          loan_enabled?: boolean
          meeting_enabled?: boolean
          member_id?: string | null
          push_enabled?: boolean
          updated_at?: string | null
        }
        Update: {
          contribution_enabled?: boolean
          dividend_enabled?: boolean
          id?: string
          loan_enabled?: boolean
          meeting_enabled?: boolean
          member_id?: string | null
          push_enabled?: boolean
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          action: Json | null
          body: string
          created_at: string
          data: Json | null
          id: string
          member_id: string
          read: boolean
          title: string
          type: string
        }
        Insert: {
          action?: Json | null
          body: string
          created_at?: string
          data?: Json | null
          id?: string
          member_id: string
          read?: boolean
          title: string
          type: string
        }
        Update: {
          action?: Json | null
          body?: string
          created_at?: string
          data?: Json | null
          id?: string
          member_id?: string
          read?: boolean
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_attempts: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          member_id: string
          metadata: Json | null
          paystack_ref: string
          status: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          member_id: string
          metadata?: Json | null
          paystack_ref: string
          status: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          member_id?: string
          metadata?: Json | null
          paystack_ref?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_attempts_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          address: string | null
          avatar_url: string | null
          bank_account: string | null
          bank_code: string | null
          bank_name: string | null
          created_at: string
          email: string | null
          expo_push_token: string | null
          full_name: string
          id: string
          member_no: string | null
          next_of_kin: string | null
          phone: string | null
          push_notifications_enabled: boolean | null
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          avatar_url?: string | null
          bank_account?: string | null
          bank_code?: string | null
          bank_name?: string | null
          created_at?: string
          email?: string | null
          expo_push_token?: string | null
          full_name: string
          id: string
          member_no?: string | null
          next_of_kin?: string | null
          phone?: string | null
          push_notifications_enabled?: boolean | null
          role?: string
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          avatar_url?: string | null
          bank_account?: string | null
          bank_code?: string | null
          bank_name?: string | null
          created_at?: string
          email?: string | null
          expo_push_token?: string | null
          full_name?: string
          id?: string
          member_no?: string | null
          next_of_kin?: string | null
          phone?: string | null
          push_notifications_enabled?: boolean | null
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          channel: string | null
          contribution_id: string | null
          created_at: string
          description: string | null
          id: string
          loan_id: string | null
          member_id: string
          metadata: Json | null
          paystack_ref: string
          status: string
          type: string
        }
        Insert: {
          amount: number
          channel?: string | null
          contribution_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          loan_id?: string | null
          member_id: string
          metadata?: Json | null
          paystack_ref: string
          status?: string
          type: string
        }
        Update: {
          amount?: number
          channel?: string | null
          contribution_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          loan_id?: string | null
          member_id?: string
          metadata?: Json | null
          paystack_ref?: string
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_contribution_id_fkey"
            columns: ["contribution_id"]
            isOneToOne: false
            referencedRelation: "contributions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_old_notifications: { Args: never; Returns: number }
      unread_notification_counts: {
        Args: { user_ids: string[] }
        Returns: { member_id: string; unread: number }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

