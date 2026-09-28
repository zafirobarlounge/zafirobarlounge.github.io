export interface Database {
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string;
          email: string;
        };
        Insert: {
          created_at?: string;
          email: string;
        };
        Update: Partial<Database['public']['Tables']['admin_users']['Insert']>;
        Relationships: [];
      };
      pos_order_items: {
        Row: {
          cancellation_reason: string | null;
          cancelled_at: string | null;
          cancelled_by_email: string | null;
          created_at: string;
          created_by_email: string;
          delivered_at: string | null;
          delivered_by_email: string | null;
          financial_status: string;
          id: string;
          menu_item_source_key: string | null;
          notes: string;
          operational_status: string;
          order_id: string;
          picking_up_at: string | null;
          picking_up_by_email: string | null;
          prep_area: string;
          preparation_started_at: string | null;
          product_name: string;
          product_slug: string;
          quantity: number;
          ready_at: string | null;
          replacement_for_item_id: string | null;
          sent_at: string | null;
          service_round: number;
          total_price: number;
          unit_price: number;
          updated_at: string;
          updated_by_email: string | null;
        };
        Insert: {
          cancellation_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by_email?: string | null;
          created_at?: string;
          created_by_email: string;
          delivered_at?: string | null;
          delivered_by_email?: string | null;
          financial_status?: string;
          id?: string;
          menu_item_source_key?: string | null;
          notes?: string;
          operational_status?: string;
          order_id: string;
          picking_up_at?: string | null;
          picking_up_by_email?: string | null;
          prep_area: string;
          preparation_started_at?: string | null;
          product_name: string;
          product_slug: string;
          quantity: number;
          ready_at?: string | null;
          replacement_for_item_id?: string | null;
          sent_at?: string | null;
          service_round?: number;
          total_price: number;
          unit_price: number;
          updated_at?: string;
          updated_by_email?: string | null;
        };
        Update: Partial<Database['public']['Tables']['pos_order_items']['Insert']>;
        Relationships: [];
      };
      pos_sales_sessions: {
        Row: {
          business_date: string;
          closed_at: string | null;
          closed_by_email: string | null;
          created_at: string;
          cutoff_hour: number;
          id: string;
          notes: string;
          opened_at: string;
          opened_by_email: string;
          session_label: string;
          status: string;
          summary: Record<string, unknown>;
          updated_at: string;
        };
        Insert: {
          business_date: string;
          closed_at?: string | null;
          closed_by_email?: string | null;
          created_at?: string;
          cutoff_hour?: number;
          id?: string;
          notes?: string;
          opened_at?: string;
          opened_by_email: string;
          session_label: string;
          status?: string;
          summary?: Record<string, unknown>;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['pos_sales_sessions']['Insert']>;
        Relationships: [];
      };
      pos_order_status_logs: {
        Row: {
          actor_email: string;
          actor_role: string | null;
          after_data: Record<string, unknown> | null;
          before_data: Record<string, unknown> | null;
          created_at: string;
          event_type: string;
          id: string;
          notes: string | null;
          order_id: string | null;
          order_item_id: string | null;
          table_id: string | null;
        };
        Insert: {
          actor_email: string;
          actor_role?: string | null;
          after_data?: Record<string, unknown> | null;
          before_data?: Record<string, unknown> | null;
          created_at?: string;
          event_type: string;
          id?: string;
          notes?: string | null;
          order_id?: string | null;
          order_item_id?: string | null;
          table_id?: string | null;
        };
        Update: Partial<Database['public']['Tables']['pos_order_status_logs']['Insert']>;
        Relationships: [];
      };
      pos_orders: {
        Row: {
          assigned_staff_email: string | null;
          cancellation_reason: string | null;
          cashier_email: string | null;
          closed_at: string | null;
          created_at: string;
          financial_status: string;
          id: string;
          notes: string;
          opened_at: string;
          opened_by_email: string;
          sales_session_id: string | null;
          table_code_snapshot: string | null;
          table_id: string | null;
          table_name_snapshot: string | null;
          updated_at: string;
        };
        Insert: {
          assigned_staff_email?: string | null;
          cancellation_reason?: string | null;
          cashier_email?: string | null;
          closed_at?: string | null;
          created_at?: string;
          financial_status?: string;
          id?: string;
          notes?: string;
          opened_at?: string;
          opened_by_email: string;
          sales_session_id?: string | null;
          table_code_snapshot?: string | null;
          table_id?: string | null;
          table_name_snapshot?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['pos_orders']['Insert']>;
        Relationships: [];
      };
      pos_payments: {
        Row: {
          allocation_mode: string;
          amount_applied: number;
          amount_received: number | null;
          change_due: number | null;
          confirmed_at: string | null;
          confirmed_by_email: string | null;
          created_at: string;
          created_by_email: string;
          id: string;
          method: string;
          notes: string | null;
          order_id: string;
          percentage_applied: number | null;
          reference: string | null;
          rejected_at: string | null;
          rejected_by_email: string | null;
          rejection_reason: string | null;
          sales_session_id: string | null;
          status: string;
          target_item_ids: unknown;
        };
        Insert: {
          allocation_mode: string;
          amount_applied: number;
          amount_received?: number | null;
          change_due?: number | null;
          confirmed_at?: string | null;
          confirmed_by_email?: string | null;
          created_at?: string;
          created_by_email: string;
          id?: string;
          method: string;
          notes?: string | null;
          order_id: string;
          percentage_applied?: number | null;
          reference?: string | null;
          rejected_at?: string | null;
          rejected_by_email?: string | null;
          rejection_reason?: string | null;
          sales_session_id?: string | null;
          status?: string;
          target_item_ids?: unknown;
        };
        Update: Partial<Database['public']['Tables']['pos_payments']['Insert']>;
        Relationships: [];
      };
      pos_tables: {
        Row: {
          active_order_id: string | null;
          assigned_staff_email: string | null;
          capacity: number | null;
          code: string;
          created_at: string;
          id: string;
          name: string;
          notes: string;
          status: string;
          type: string;
          updated_at: string;
          zone: string;
        };
        Insert: {
          active_order_id?: string | null;
          assigned_staff_email?: string | null;
          capacity?: number | null;
          code: string;
          created_at?: string;
          id?: string;
          name: string;
          notes?: string;
          status?: string;
          type: string;
          updated_at?: string;
          zone: string;
        };
        Update: Partial<Database['public']['Tables']['pos_tables']['Insert']>;
        Relationships: [];
      };
      staff_profiles: {
        Row: {
          created_at: string;
          email: string;
          full_name: string;
          is_active: boolean;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          full_name: string;
          is_active?: boolean;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['staff_profiles']['Insert']>;
        Relationships: [];
      };
      staff_role_assignments: {
        Row: {
          created_at: string;
          email: string;
          role: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          role: string;
        };
        Update: Partial<Database['public']['Tables']['staff_role_assignments']['Insert']>;
        Relationships: [];
      };
      menu_change_logs: {
        Row: {
          actor_label: string | null;
          after_data: Record<string, unknown>;
          applied_at: string;
          before_data: Record<string, unknown>;
          change_source: string;
          changed_fields: Record<string, unknown>;
          id: string;
          item_slug: string;
          menu_item_source_key: string;
        };
        Insert: {
          actor_label?: string | null;
          after_data: Record<string, unknown>;
          applied_at?: string;
          before_data: Record<string, unknown>;
          change_source?: string;
          changed_fields: Record<string, unknown>;
          id?: string;
          item_slug: string;
          menu_item_source_key: string;
        };
        Update: Partial<Database['public']['Tables']['menu_change_logs']['Insert']>;
        Relationships: [];
      };
      menu_items: {
        Row: {
          created_at: string;
          description: string;
          disponible: boolean;
          destacado: boolean;
          emplatado: string;
          hoja_origen: string;
          id: string;
          imagen: string;
          ingredientes: string;
          legacy_id: number;
          name: string;
          orden: number;
          precio_venta: number | null;
          preparacion: string;
          slug: string;
          source_key: string;
          subgrupo: string | null;
          tipo: string;
          updated_at: string;
          visible: boolean;
        };
        Insert: {
          created_at?: string;
          description?: string;
          disponible?: boolean;
          destacado?: boolean;
          emplatado?: string;
          hoja_origen: string;
          id?: string;
          imagen?: string;
          ingredientes?: string;
          legacy_id: number;
          name: string;
          orden: number;
          precio_venta?: number | null;
          preparacion?: string;
          slug: string;
          source_key: string;
          subgrupo?: string | null;
          tipo: string;
          updated_at?: string;
          visible?: boolean;
        };
        Update: Partial<Database['public']['Tables']['menu_items']['Insert']>;
        Relationships: [];
      };
      menu_snapshots: {
        Row: {
          created_at: string;
          id: string;
          payload: Record<string, unknown>;
          snapshot_kind: string;
          summary: Record<string, unknown>;
        };
        Insert: {
          created_at?: string;
          id?: string;
          payload: Record<string, unknown>;
          snapshot_kind: string;
          summary: Record<string, unknown>;
        };
        Update: Partial<Database['public']['Tables']['menu_snapshots']['Insert']>;
        Relationships: [];
      };
    };
    Views: {
      menu_items_public: {
        Row: Database['public']['Tables']['menu_items']['Row'];
        Relationships: [];
      };
    };
    Functions: {
      pos_session_report: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      pos_session_report_v2: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      pos_session_adjustment: { Args: { request_id: string; payload: Record<string, unknown> }; Returns: Record<string, unknown> };
      pos_cash_open: { Args: { request_id: string; payload: Record<string, unknown> }; Returns: Record<string, unknown> };
      pos_cash_ensure_session: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      pos_cash_read: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      pos_cash_command: { Args: { request_id: string; payload: Record<string, unknown> }; Returns: Record<string, unknown> };
      has_staff_role: {
        Args: {
          requested_role: string;
        };
        Returns: boolean;
      };
      is_catalog_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      is_pos_staff: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      move_pos_active_order_to_table: {
        Args: {
          destination_table_id: string;
          source_table_id: string;
        };
        Returns: Record<string, unknown>;
      };
    };
  };
}
